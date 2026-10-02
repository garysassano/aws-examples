//! AWS Lambda function that forwards the sample functions' OTLP spans to an exporter.
//!
//! The spans arrive through one of two transports, each with its own event shape:
//! - logs-subscription: CloudWatch Logs subscription events holding otlp-stdout log lines
//! - kinesis: Kinesis records, each holding one otlp-stdout line from the extension
//!
//! Each parser unwraps its transport's event down to the OTLP protobuf, and the core
//! library compacts the spans into one batch and sends it to the configured endpoint,
//! signed with SigV4 when the endpoint is CloudWatch's.

use anyhow::Result;
use aws_config::BehaviorVersion;
use aws_lambda_events::event::cloudwatch_logs::LogsEvent;
use aws_lambda_events::event::kinesis::KinesisEvent;
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
use serde::de::{Error as _, IgnoredAny};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::value::RawValue;
use serverless_otlp_forwarder_core::{
    InstrumentedHttpClient, processor::process_event_batch, span_compactor::SpanCompactionConfig,
};

use std::{collections::HashMap, env, sync::Arc};

mod parser;
mod sigv4;
use parser::{CloudWatchLogsOtlpStdoutParser, KinesisOtlpStdoutParser};
use sigv4::{ForwarderClient, SigV4HttpClient};

/// The event shapes the two transports deliver.
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum ForwarderEvent {
    CloudWatchLogs(LogsEvent),
    Kinesis(KinesisEvent),
}

/// The top-level key that tells the two events apart.
#[derive(Deserialize)]
struct EventShape {
    awslogs: Option<IgnoredAny>,
}

// Not `#[serde(untagged)]`: untagged buffers the input, and the awslogs deserializer
// borrows its keys, which buffered input cannot lend. Keeping the raw JSON and parsing
// it once into the matching type avoids both the buffering and a second parse.
impl<'de> Deserialize<'de> for ForwarderEvent {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = Box::<RawValue>::deserialize(deserializer)?;
        let json = raw.get();
        let event = if serde_json::from_str::<EventShape>(json)
            .map_err(D::Error::custom)?
            .awslogs
            .is_some()
        {
            serde_json::from_str(json).map(ForwarderEvent::CloudWatchLogs)
        } else {
            serde_json::from_str(json).map(ForwarderEvent::Kinesis)
        };
        event.map_err(D::Error::custom)
    }
}

impl SpanAttributesExtractor for ForwarderEvent {
    fn extract_span_attributes(&self) -> SpanAttributes {
        let mut attributes: HashMap<String, OtelValue> = HashMap::new();
        let (trigger, span_name, count) = match self {
            ForwarderEvent::CloudWatchLogs(event) => {
                let log_data = &event.aws_logs.data;
                attributes.insert(
                    "aws.cloudwatch.log_group".to_string(),
                    OtelValue::String(log_data.log_group.clone().into()),
                );
                attributes.insert(
                    "aws.cloudwatch.log_stream".to_string(),
                    OtelValue::String(log_data.log_stream.clone().into()),
                );
                (
                    "cloudwatch_logs",
                    format!("log {}", log_data.log_group),
                    log_data.log_events.len(),
                )
            }
            ForwarderEvent::Kinesis(event) => {
                if let Some(arn) = event
                    .records
                    .first()
                    .and_then(|r| r.event_source_arn.as_ref())
                {
                    attributes.insert(
                        "aws.kinesis.event_source_arn".to_string(),
                        OtelValue::String(arn.clone().into()),
                    );
                }
                (
                    "aws_kinesis",
                    "kinesis_event_processor".to_string(),
                    event.records.len(),
                )
            }
        };
        attributes.insert(
            "faas.trigger.type".to_string(),
            OtelValue::String(trigger.into()),
        );
        attributes.insert(
            "otlp_forwarder.records.count".to_string(),
            OtelValue::I64(count as i64),
        );

        SpanAttributes::builder()
            .span_name(span_name)
            .kind("consumer".to_string()) // As per OpenTelemetry semantic conventions for messaging
            .attributes(attributes)
            .build()
    }
}

// Lambda function handler: parses the batch and forwards it with the core library.
async fn function_handler(
    event: LambdaEvent<ForwarderEvent>,
    http_client: Arc<ForwarderClient>,
) -> Result<(), LambdaError> {
    let client = http_client.as_ref();
    let compaction_config = SpanCompactionConfig::default();
    let result = match event.payload {
        ForwarderEvent::CloudWatchLogs(event) => {
            let log_group = event.aws_logs.data.log_group.clone();
            process_event_batch(
                event,
                &CloudWatchLogsOtlpStdoutParser,
                &log_group,
                client,
                &compaction_config,
            )
            .await
        }
        ForwarderEvent::Kinesis(event) => {
            let stream_arn = event
                .records
                .first()
                .and_then(|record| record.event_source_arn.clone())
                .unwrap_or_else(|| "kinesis_stream_unknown".to_string());
            process_event_batch(
                event,
                &KinesisOtlpStdoutParser,
                &stream_arn,
                client,
                &compaction_config,
            )
            .await
        }
    };

    result.map_err(|e| {
        tracing::error!(error = %e, "Error processing event batch.");
        LambdaError::from(e.to_string())
    })
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
        .service_fn(move |event: LambdaEvent<ForwarderEvent>| {
            let client_for_handler = Arc::clone(&http_client_for_forwarding);
            async move { function_handler(event, client_for_handler).await }
        });

    tracing::info!("Starting Lambda runtime.");
    Runtime::new(service).run().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Parses from text, as the Lambda runtime does, so borrowing deserializers behave
    // the same as in production.
    fn parse(event: serde_json::Value) -> ForwarderEvent {
        serde_json::from_str(&event.to_string()).unwrap()
    }

    #[test]
    fn test_event_shapes_pick_their_variant() {
        // awslogs.data is a gzipped, base64-encoded CloudWatch Logs document.
        let logs = parse(
            json!({ "awslogs": { "data": "H4sIAAAAAAAC/6tWyk0tLk5MTw2pLEhVslJQcnEMcYz3dQ0OdnR3VdJRUMovz0stAkkYgng5+enuRfmlBSCBdKhAcElRamIuSKQYJFJcmlScXJRZUJKZn+eWmVOSWlQMlIuOhSh2LUvNK4EI1AIA+UwreHwAAAA=" } }),
        );
        assert!(matches!(logs, ForwarderEvent::CloudWatchLogs(_)));

        let kinesis = parse(json!({ "Records": [] }));
        assert!(matches!(kinesis, ForwarderEvent::Kinesis(_)));
    }
}
