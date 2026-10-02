//! AWS Lambda function that forwards CloudWatch log wrapped OTLP records to OpenTelemetry collectors.
//!
//! This Lambda function:
//! 1. Receives CloudWatch log events in otlp-stdout format
//! 2. Decodes and decompresses the log data
//! 3. Converts logs to TelemetryData
//! 4. Compacts multiple telemetry items into batches
//! 5. Forwards the batched data to an OTLP collector endpoint
//!
//! The function supports:
//! - Configurable OTLP collector endpoint via environment variables
//! - Custom headers and authentication via environment variables
//! - Base64 encoded payloads
//! - Gzip compressed data
//! - Span compaction and batching for efficiency
//! - Self-instrumentation with OpenTelemetry tracing

use anyhow::Result;
use aws_config::BehaviorVersion;
use aws_lambda_events::event::cloudwatch_logs::LogsEvent;
use lambda_otel_lite::{
    LambdaSpanProcessor, OtelTracingLayer, SpanAttributes, SpanAttributesExtractor,
    TelemetryConfig, init_telemetry,
};
use lambda_runtime::{Error as LambdaError, LambdaEvent, Runtime, tower::ServiceBuilder};
use opentelemetry::Value as OtelValue;
use opentelemetry_otlp::{Protocol, WithExportConfig};
use otlp_stdout_span_exporter::OtlpStdoutSpanExporter;
use reqwest::Client as ReqwestClient;
use reqwest_middleware::ClientBuilder;
use reqwest_tracing::TracingMiddleware;
use serde::{Deserialize, Serialize};
use serverless_otlp_forwarder_core::{
    InstrumentedHttpClient, processor::process_event_batch, span_compactor::SpanCompactionConfig,
};

use std::{collections::HashMap, env, sync::Arc};

// The specific parser for this Lambda, defined in the local parser.rs
mod parser;
mod sigv4;
use parser::CloudWatchLogsOtlpStdoutParser;
use sigv4::{ForwarderClient, SigV4HttpClient};

// Define a wrapper for LogsEvent to implement SpanAttributesExtractor
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LogsEventProcessorWrapper(LogsEvent);

impl SpanAttributesExtractor for LogsEventProcessorWrapper {
    fn extract_span_attributes(&self) -> SpanAttributes {
        let mut attributes: HashMap<String, OtelValue> = HashMap::new();
        let log_data = &self.0.aws_logs.data;

        attributes.insert(
            "faas.trigger.type".to_string(),
            OtelValue::String("cloudwatch_logs".into()),
        );
        attributes.insert(
            "aws.cloudwatch.log_group".to_string(),
            OtelValue::String(log_data.log_group.clone().into()),
        );
        attributes.insert(
            "aws.cloudwatch.log_stream".to_string(),
            OtelValue::String(log_data.log_stream.clone().into()),
        );
        attributes.insert(
            "aws.cloudwatch.owner".to_string(),
            OtelValue::String(log_data.owner.clone().into()),
        );
        attributes.insert(
            "aws.cloudwatch.events.count".to_string(),
            OtelValue::I64(log_data.log_events.len() as i64),
        );

        SpanAttributes::builder()
            .span_name(format!("log {}", log_data.log_group.clone()))
            .kind("consumer".to_string()) // As per OpenTelemetry semantic conventions for messaging
            .attributes(attributes)
            .build()
    }
}

// Main Lambda function handler - simplified to use the core library
async fn function_handler(
    event: LambdaEvent<LogsEventProcessorWrapper>,
    http_client: Arc<ForwarderClient>,
) -> Result<(), LambdaError> {
    tracing::debug!("Processing CloudWatch Logs batch.");

    let log_group = event.payload.0.aws_logs.data.log_group.clone();

    let parser = CloudWatchLogsOtlpStdoutParser;
    let compaction_config = SpanCompactionConfig::default();

    match process_event_batch(
        event.payload.0,
        &parser,
        &log_group,
        http_client.as_ref(),
        &compaction_config,
    )
    .await
    {
        Ok(_) => {
            tracing::debug!("Batch processed successfully.");
            Ok(())
        }
        Err(e) => {
            tracing::error!(error = %e, "Error processing event batch.");
            Err(LambdaError::from(e.to_string()))
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), LambdaError> {
    // Set to the endpoint's signing name, `xray`, for the CloudWatch OTLP endpoint, which
    // takes SigV4 instead of static headers.
    let sigv4_service = env::var("OTLP_SIGV4_SERVICE").ok();

    // The forwarder's own spans go to the same endpoint, except when it must sign: the
    // SDK exporter cannot, so they stay in the forwarder's log group instead.
    let (_, completion_handler) = if sigv4_service.is_some() {
        init_telemetry(
            TelemetryConfig::builder()
                .with_span_processor(
                    LambdaSpanProcessor::builder()
                        .exporter(OtlpStdoutSpanExporter::default())
                        .build(),
                )
                .build(),
        )
        .await?
    } else {
        // Endpoint and headers come from the OTEL_EXPORTER_OTLP_* variables.
        let otlp_http_exporter = opentelemetry_otlp::SpanExporter::builder()
            .with_http()
            .with_protocol(Protocol::HttpBinary)
            .build()?;
        init_telemetry(
            TelemetryConfig::builder()
                .with_span_processor(
                    LambdaSpanProcessor::builder()
                        .exporter(otlp_http_exporter)
                        .build(),
                )
                .build(),
        )
        .await?
    };
    tracing::info!("lambda-otel-lite initialized.");

    let client_with_middleware = ClientBuilder::new(ReqwestClient::new())
        .with(TracingMiddleware::default())
        .build();
    let instrumented_client = InstrumentedHttpClient::new(client_with_middleware);

    let http_client_for_forwarding = Arc::new(match sigv4_service {
        Some(service) => {
            let aws_config = aws_config::load_defaults(BehaviorVersion::latest()).await;
            let credentials = aws_config
                .credentials_provider()
                .ok_or("No credentials provider for SigV4 signing")?;
            let region = aws_config
                .region()
                .ok_or("No region for SigV4 signing")?
                .to_string();
            tracing::info!(service = %service, "Signing OTLP requests with SigV4.");
            ForwarderClient::Signed(SigV4HttpClient::new(
                instrumented_client,
                credentials,
                region,
                service,
            ))
        }
        None => ForwarderClient::Plain(instrumented_client),
    });

    let service = ServiceBuilder::new()
        .layer(OtelTracingLayer::new(completion_handler))
        .service_fn(move |event: LambdaEvent<LogsEventProcessorWrapper>| {
            let client_for_handler = Arc::clone(&http_client_for_forwarding);
            async move { function_handler(event, client_for_handler).await }
        });

    tracing::info!("Starting Lambda runtime.");
    Runtime::new(service).run().await
}
