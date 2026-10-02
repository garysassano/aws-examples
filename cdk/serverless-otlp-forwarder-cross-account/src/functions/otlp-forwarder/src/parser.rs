use std::io::Read;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use aws_lambda_events::event::cloudwatch_logs::{LogData, LogEntry, LogsEvent};
use aws_lambda_events::event::kinesis::KinesisEvent;
use flate2::read::GzDecoder;
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use otlp_stdout_span_exporter::ExporterOutput;
use prost::Message;
use serverless_otlp_forwarder_core::core_parser::EventParser;
use serverless_otlp_forwarder_core::telemetry::TelemetryData;

// CloudWatch Logs writes one of these to a new destination to check that it can deliver.
const CONTROL_MESSAGE: &str = "CONTROL_MESSAGE";

/// Turns one otlp-stdout log line into TelemetryData, skipping lines that are not one.
fn from_log_line(message: &str) -> Option<TelemetryData> {
    let record: ExporterOutput = match serde_json::from_str(message) {
        Ok(record) => record,
        Err(err) => {
            tracing::warn!(error = %err, "Log line is not otlp-stdout output. Skipping.");
            return None;
        }
    };
    match TelemetryData::from_log_record(record) {
        Ok(telemetry) => Some(telemetry),
        Err(err) => {
            tracing::warn!(error = %err, "Failed to decode otlp-stdout payload. Skipping.");
            None
        }
    }
}

fn from_log_entries(log_events: Vec<LogEntry>) -> Vec<TelemetryData> {
    log_events
        .iter()
        .filter_map(|log_event| from_log_line(&log_event.message))
        .collect()
}

/// logs-centralization: a subscription filter on a centralized log group invokes the
/// forwarder in the same account, so the event is the usual awslogs payload.
pub struct CloudWatchLogsParser;

impl EventParser for CloudWatchLogsParser {
    type EventInput = LogsEvent;

    fn parse(&self, event: LogsEvent, _source: &str) -> Result<Vec<TelemetryData>> {
        Ok(from_log_entries(event.aws_logs.data.log_events))
    }
}

/// logs-destination: the CloudWatch Logs destination writes each subscription delivery
/// to Kinesis as one gzipped JSON document, the same one awslogs.data carries.
pub struct KinesisCloudWatchLogsParser;

impl EventParser for KinesisCloudWatchLogsParser {
    type EventInput = KinesisEvent;

    fn parse(&self, event: KinesisEvent, _source: &str) -> Result<Vec<TelemetryData>> {
        let mut telemetry_items = Vec::new();
        for record in event.records {
            let log_data = match decode_log_data(&record.kinesis.data.0) {
                Ok(log_data) => log_data,
                Err(err) => {
                    tracing::warn!(error = %err, "Failed to decode Kinesis record. Skipping.");
                    continue;
                }
            };
            if log_data.message_type == CONTROL_MESSAGE {
                tracing::debug!("Skipping CloudWatch Logs control message.");
                continue;
            }
            telemetry_items.extend(from_log_entries(log_data.log_events));
        }
        Ok(telemetry_items)
    }
}

fn decode_log_data(data: &[u8]) -> Result<LogData> {
    let mut json = Vec::new();
    GzDecoder::new(data)
        .read_to_end(&mut json)
        .context("Failed to gunzip CloudWatch Logs data")?;
    serde_json::from_slice(&json).context("Failed to parse CloudWatch Logs data")
}

/// event-bus: the extension publishes the gzipped OTLP protobuf as raw bytes, and a
/// Lambda target receives only each event's data, which for raw bytes is a base64
/// string. The protobuf names its own service, so the event metadata is not needed.
pub struct EventBusParser;

impl EventParser for EventBusParser {
    type EventInput = Vec<String>;

    fn parse(&self, events: Vec<String>, _source: &str) -> Result<Vec<TelemetryData>> {
        let mut telemetry_items = Vec::with_capacity(events.len());
        for data in events {
            // Rebuild the record the log line would have held, so the payload goes
            // through the same decoding as the other transports.
            let record = ExporterOutput {
                version: String::new(),
                source: "event_bus".to_string(),
                endpoint: String::new(),
                method: "POST".to_string(),
                content_type: "application/x-protobuf".to_string(),
                content_encoding: "gzip".to_string(),
                headers: None,
                payload: data,
                base64: true,
                level: None,
            };
            match TelemetryData::from_log_record(record) {
                Ok(telemetry) => telemetry_items.push(telemetry),
                Err(err) => {
                    tracing::warn!(error = %err, "Failed to decode event payload. Skipping.");
                }
            }
        }
        Ok(telemetry_items)
    }
}

/// Wraps a parser to report how long the spans took to reach the forwarder, measured
/// from the latest span end time in the batch, as a CloudWatch embedded metric.
pub struct LatencyRecordingParser<'a, P> {
    pub inner: P,
    pub transport: &'a str,
}

impl<P: EventParser> EventParser for LatencyRecordingParser<'_, P> {
    type EventInput = P::EventInput;

    fn parse(&self, event: P::EventInput, source: &str) -> Result<Vec<TelemetryData>> {
        let telemetry_items = self.inner.parse(event, source)?;
        if let Some(latest_end) = latest_span_end_unix_nano(&telemetry_items) {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .context("System clock is before the Unix epoch")?
                .as_nanos() as u64;
            let latency_ms = now.saturating_sub(latest_end) / 1_000_000;
            println!("{}", delivery_latency_metric(self.transport, latency_ms));
        }
        Ok(telemetry_items)
    }
}

/// Finds the latest span end time across the batch's decompressed OTLP payloads.
fn latest_span_end_unix_nano(telemetry_items: &[TelemetryData]) -> Option<u64> {
    telemetry_items
        .iter()
        .filter_map(|item| ExportTraceServiceRequest::decode(item.payload.as_slice()).ok())
        .flat_map(|request| request.resource_spans)
        .flat_map(|resource_spans| resource_spans.scope_spans)
        .flat_map(|scope_spans| scope_spans.spans)
        .map(|span| span.end_time_unix_nano)
        .max()
}

fn delivery_latency_metric(transport: &str, latency_ms: u64) -> String {
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default();
    serde_json::json!({
        "_aws": {
            "Timestamp": timestamp_ms,
            "CloudWatchMetrics": [{
                "Namespace": "OtlpForwarder",
                "Dimensions": [["Transport"]],
                "Metrics": [{ "Name": "DeliveryLatency", "Unit": "Milliseconds" }]
            }]
        },
        "Transport": transport,
        "DeliveryLatency": latency_ms
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_lambda_events::event::kinesis::KinesisEventRecord;
    use flate2::{Compression, write::GzEncoder};
    use serde_json::json;
    use std::io::Write;

    // A base64-encoded, gzipped, empty OTLP ExportTraceServiceRequest.
    const VALID_TEST_PAYLOAD_STRING: &str = "H4sIAAAAAAAAAAMAAAAAAAAAAAA=";

    // A log message in the otlp_stdout_span_exporter::ExporterOutput format.
    fn exporter_output(source: &str) -> String {
        json!({
            "__otel_otlp_stdout": "otlp-stdout-span-exporter@0.17.1",
            "source": source,
            "endpoint": "http://original.collector/v1/traces",
            "method": "POST",
            "payload": VALID_TEST_PAYLOAD_STRING,
            "content-type": "application/x-protobuf",
            "content-encoding": "gzip",
            "base64": true
        })
        .to_string()
    }

    fn log_entries(messages: Vec<String>) -> Vec<LogEntry> {
        messages
            .into_iter()
            .map(|message| {
                let mut entry = LogEntry::default();
                entry.message = message;
                entry
            })
            .collect()
    }

    fn gzip(data: &[u8]) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(data).unwrap();
        encoder.finish().unwrap()
    }

    fn kinesis_record(message_type: &str, messages: Vec<String>) -> KinesisEventRecord {
        let log_data = json!({
            "messageType": message_type,
            "owner": "111122223333",
            "logGroup": "/aws/lambda/test-func",
            "logStream": "stream",
            "subscriptionFilters": ["otlp"],
            "logEvents": messages.iter().enumerate().map(|(i, message)| json!({
                "id": i.to_string(),
                "timestamp": 0,
                "message": message
            })).collect::<Vec<_>>()
        });
        let mut record = KinesisEventRecord::default();
        record.kinesis.data.0 = gzip(log_data.to_string().as_bytes());
        record
    }

    #[test]
    fn test_cloudwatch_logs_parser_skips_other_lines() {
        let mut event = LogsEvent::default();
        event.aws_logs.data.log_events = log_entries(vec![
            exporter_output("service-a"),
            "plain log line".to_string(),
        ]);

        let result = CloudWatchLogsParser.parse(event, "").unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].source, "service-a");
        assert_eq!(result[0].content_encoding, None);
    }

    #[test]
    fn test_kinesis_parser_unwraps_cloudwatch_logs_data() {
        let mut event = KinesisEvent::default();
        event.records = vec![
            kinesis_record("CONTROL_MESSAGE", vec!["CWL CONTROL MESSAGE".to_string()]),
            kinesis_record(
                "DATA_MESSAGE",
                vec![exporter_output("service-a"), exporter_output("service-b")],
            ),
        ];

        let result = KinesisCloudWatchLogsParser.parse(event, "").unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[1].source, "service-b");
    }

    #[test]
    fn test_kinesis_parser_skips_undecodable_records() {
        let mut bad = KinesisEventRecord::default();
        bad.kinesis.data.0 = b"not gzip".to_vec();
        let mut event = KinesisEvent::default();
        event.records = vec![
            bad,
            kinesis_record("DATA_MESSAGE", vec![exporter_output("ok")]),
        ];

        let result = KinesisCloudWatchLogsParser.parse(event, "").unwrap();
        assert_eq!(result.len(), 1);
    }

    #[test]
    fn test_event_bus_parser_decodes_raw_data() {
        // The array a Lambda target receives: each event's data as a base64 string.
        let events: Vec<String> =
            serde_json::from_value(json!([VALID_TEST_PAYLOAD_STRING, "not base64"])).unwrap();

        let result = EventBusParser.parse(events, "").unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].content_type, "application/x-protobuf");
        assert_eq!(result[0].content_encoding, None);
    }

    #[test]
    fn test_latency_metric_is_embedded_metric_format() {
        let metric: serde_json::Value =
            serde_json::from_str(&delivery_latency_metric("event-bus", 42)).unwrap();
        assert_eq!(metric["Transport"], "event-bus");
        assert_eq!(metric["DeliveryLatency"], 42);
        assert_eq!(
            metric["_aws"]["CloudWatchMetrics"][0]["Namespace"],
            "OtlpForwarder"
        );
    }
}
