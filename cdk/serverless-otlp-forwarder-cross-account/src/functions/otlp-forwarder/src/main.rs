//! AWS Lambda function that forwards OTLP spans from a source account to CloudWatch.
//!
//! The spans reach this account through one of three transports, each with its own
//! event shape:
//! - logs-destination: Kinesis records holding gzipped CloudWatch Logs subscription data
//! - logs-centralization: CloudWatch Logs subscription events from centralized log groups
//! - event-bus: batches of raw events from a Custom Event Bus subscriber
//!
//! Each parser unwraps its transport's layers down to the OTLP protobuf, and the core
//! library compacts the spans into one batch and sends it, signed with SigV4, to this
//! account's CloudWatch OTLP endpoint.

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
use otlp_stdout_span_exporter::OtlpStdoutSpanExporter;
use reqwest::Client as ReqwestClient;
use reqwest_middleware::ClientBuilder;
use reqwest_tracing::TracingMiddleware;
use serde::de::{Error as _, IgnoredAny};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::value::RawValue;
use serverless_otlp_forwarder_core::{
    InstrumentedHttpClient, core_parser::EventParser, processor::process_event_batch,
    span_compactor::SpanCompactionConfig,
};

use std::{collections::HashMap, env, sync::Arc};

mod parser;
mod sigv4;
use parser::{
    CloudWatchLogsParser, EventBusParser, KinesisCloudWatchLogsParser, LatencyRecordingParser,
};
use sigv4::SigV4HttpClient;

/// The event shapes the three transports deliver.
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum ForwarderEvent {
    CloudWatchLogs(LogsEvent),
    Kinesis(KinesisEvent),
    EventBus(Vec<String>),
}

/// Top-level keys that tell the object-shaped events apart.
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
        let event = if json.trim_start().starts_with('[') {
            serde_json::from_str(json).map(ForwarderEvent::EventBus)
        } else if serde_json::from_str::<EventShape>(json)
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
                (
                    "cloudwatch_logs",
                    format!("log {}", log_data.log_group),
                    log_data.log_events.len(),
                )
            }
            ForwarderEvent::Kinesis(event) => (
                "aws_kinesis",
                "kinesis_event_processor".to_string(),
                event.records.len(),
            ),
            ForwarderEvent::EventBus(events) => (
                "aws_eventbridge",
                "event_bus_event_processor".to_string(),
                events.len(),
            ),
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
            .kind("consumer".to_string())
            .attributes(attributes)
            .build()
    }
}

async fn process<P: EventParser + Sync + Send>(
    event: P::EventInput,
    parser: P,
    source: &str,
    transport: &str,
    http_client: &SigV4HttpClient,
) -> Result<()> {
    let parser = LatencyRecordingParser {
        inner: parser,
        transport,
    };
    process_event_batch(
        event,
        &parser,
        source,
        http_client,
        &SpanCompactionConfig::default(),
    )
    .await
}

async fn function_handler(
    event: LambdaEvent<ForwarderEvent>,
    http_client: Arc<SigV4HttpClient>,
    transport: Arc<String>,
) -> Result<(), LambdaError> {
    let client = http_client.as_ref();
    let result = match event.payload {
        ForwarderEvent::CloudWatchLogs(event) => {
            let log_group = event.aws_logs.data.log_group.clone();
            process(event, CloudWatchLogsParser, &log_group, &transport, client).await
        }
        ForwarderEvent::Kinesis(event) => {
            let stream_arn = event
                .records
                .first()
                .and_then(|record| record.event_source_arn.clone())
                .unwrap_or_else(|| "kinesis_stream_unknown".to_string());
            process(
                event,
                KinesisCloudWatchLogsParser,
                &stream_arn,
                &transport,
                client,
            )
            .await
        }
        ForwarderEvent::EventBus(events) => {
            process(events, EventBusParser, "event_bus", &transport, client).await
        }
    };

    result.map_err(|e| {
        tracing::error!(error = %e, "Error processing event batch.");
        LambdaError::from(e.to_string())
    })
}

#[tokio::main]
async fn main() -> Result<(), LambdaError> {
    // The forwarder's own spans stay in its log group: the CloudWatch OTLP endpoint needs
    // SigV4, which the SDK's exporters cannot add.
    let (_, completion_handler) = init_telemetry(
        TelemetryConfig::builder()
            .with_span_processor(
                LambdaSpanProcessor::builder()
                    .exporter(OtlpStdoutSpanExporter::default())
                    .build(),
            )
            .build(),
    )
    .await?;
    tracing::info!("lambda-otel-lite initialized.");

    let client_with_middleware = ClientBuilder::new(ReqwestClient::new())
        .with(TracingMiddleware::default())
        .build();

    let aws_config = aws_config::load_defaults(BehaviorVersion::latest()).await;
    let credentials = aws_config
        .credentials_provider()
        .ok_or("No credentials provider for SigV4 signing")?;
    let region = aws_config
        .region()
        .ok_or("No region for SigV4 signing")?
        .to_string();
    let http_client_for_forwarding = Arc::new(SigV4HttpClient::new(
        InstrumentedHttpClient::new(client_with_middleware),
        credentials,
        region,
        "xray".to_string(),
    ));

    // Labels the delivery latency metric with the transport the stack deployed.
    let transport = Arc::new(env::var("TRANSPORT").unwrap_or_else(|_| "unknown".to_string()));

    let service = ServiceBuilder::new()
        .layer(OtelTracingLayer::new(completion_handler))
        .service_fn(move |event: LambdaEvent<ForwarderEvent>| {
            let client_for_handler = Arc::clone(&http_client_for_forwarding);
            let transport = Arc::clone(&transport);
            async move { function_handler(event, client_for_handler, transport).await }
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

        let bus = parse(json!(["H4sIAAAAAAAAAAMAAAAAAAAAAAA="]));
        assert!(matches!(bus, ForwarderEvent::EventBus(_)));
    }
}
