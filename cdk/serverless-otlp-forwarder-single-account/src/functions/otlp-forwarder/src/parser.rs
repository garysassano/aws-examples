use anyhow::Result;
use aws_lambda_events::event::cloudwatch_logs::LogsEvent;
use aws_lambda_events::event::kinesis::KinesisEvent;
use otlp_stdout_span_exporter::ExporterOutput;
use serverless_otlp_forwarder_core::core_parser::EventParser;
use serverless_otlp_forwarder_core::telemetry::TelemetryData;

/// Turns one otlp-stdout JSON line into TelemetryData, skipping lines that are not one.
fn from_otlp_stdout_line(line: &[u8]) -> Option<TelemetryData> {
    let record: ExporterOutput = match serde_json::from_slice(line) {
        Ok(record) => record,
        Err(err) => {
            tracing::warn!(error = %err, "Record is not otlp-stdout output. Skipping.");
            return None;
        }
    };
    // from_log_record decodes and decompresses the payload.
    match TelemetryData::from_log_record(record) {
        Ok(telemetry) => Some(telemetry),
        Err(err) => {
            tracing::warn!(error = %err, "Failed to decode otlp-stdout payload. Skipping.");
            None
        }
    }
}

/// logs-subscription: the account-level subscription filter delivers the sample
/// functions' otlp-stdout log lines.
pub struct CloudWatchLogsOtlpStdoutParser;

impl EventParser for CloudWatchLogsOtlpStdoutParser {
    type EventInput = LogsEvent;

    fn parse(&self, event: LogsEvent, _log_group: &str) -> Result<Vec<TelemetryData>> {
        Ok(event
            .aws_logs
            .data
            .log_events
            .iter()
            .filter_map(|log_event| from_otlp_stdout_line(log_event.message.as_bytes()))
            .collect())
    }
}

/// kinesis: the extension puts each otlp-stdout line the function exports into the
/// stream as one record.
pub struct KinesisOtlpStdoutParser;

impl EventParser for KinesisOtlpStdoutParser {
    type EventInput = KinesisEvent;

    fn parse(&self, event: KinesisEvent, _stream_arn: &str) -> Result<Vec<TelemetryData>> {
        Ok(event
            .records
            .iter()
            .filter_map(|record| from_otlp_stdout_line(&record.kinesis.data.0))
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_lambda_events::event::cloudwatch_logs::LogEntry;
    use aws_lambda_events::event::kinesis::KinesisEventRecord;
    use serde_json::json;

    // A base64-encoded, gzipped, empty OTLP ExportTraceServiceRequest.
    const VALID_TEST_PAYLOAD_STRING: &str = "H4sIAAAAAAAAAAMAAAAAAAAAAAA=";

    // A line in the otlp_stdout_span_exporter::ExporterOutput format.
    fn exporter_output(source: &str) -> String {
        json!({
            "__otel_otlp_stdout": "otlp-stdout-span-exporter@0.17.1",
            "source": source,
            "endpoint": "http://original.collector/v1/traces",
            "method": "POST",
            "payload": VALID_TEST_PAYLOAD_STRING,
            "headers": {
                "content-type": "application/x-protobuf"
            },
            "content-type": "application/x-protobuf",
            "content-encoding": "gzip",
            "base64": true
        })
        .to_string()
    }

    fn logs_event(messages: Vec<String>) -> LogsEvent {
        let mut event = LogsEvent::default();
        event.aws_logs.data.log_group = "/aws/lambda/test-func".to_string();
        event.aws_logs.data.log_events = messages
            .into_iter()
            .map(|message| {
                let mut entry = LogEntry::default();
                entry.message = message;
                entry
            })
            .collect();
        event
    }

    fn kinesis_event(records: Vec<Vec<u8>>) -> KinesisEvent {
        let mut event = KinesisEvent::default();
        event.records = records
            .into_iter()
            .map(|data| {
                let mut record = KinesisEventRecord::default();
                record.kinesis.data.0 = data;
                record
            })
            .collect();
        event
    }

    #[test]
    fn test_cloudwatch_logs_parser_success() {
        let event = logs_event(vec![
            exporter_output("service-a"),
            exporter_output("service-b"),
        ]);

        let result = CloudWatchLogsOtlpStdoutParser
            .parse(event, "/aws/lambda/test-func")
            .unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].source, "service-a");
        assert_eq!(result[1].source, "service-b");
        assert_eq!(result[0].content_type, "application/x-protobuf");
        assert_eq!(result[0].content_encoding, None);
    }

    #[test]
    fn test_cloudwatch_logs_parser_malformed_json_in_log_entry() {
        let event = logs_event(vec![
            "{\"key\": \"value\" but not closed".to_string(),
            exporter_output("service-ok"),
        ]);

        let result = CloudWatchLogsOtlpStdoutParser
            .parse(event, "/aws/lambda/test-func")
            .unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].source, "service-ok");
    }

    #[test]
    fn test_cloudwatch_logs_parser_empty_log_events_list() {
        let result = CloudWatchLogsOtlpStdoutParser
            .parse(logs_event(vec![]), "/aws/lambda/test-func")
            .unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn test_kinesis_parser_success() {
        let event = kinesis_event(vec![
            exporter_output("service-c").into_bytes(),
            exporter_output("service-d").into_bytes(),
        ]);

        let result = KinesisOtlpStdoutParser.parse(event, "test-stream").unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].source, "service-c");
        assert_eq!(result[1].source, "service-d");
        assert_eq!(result[0].content_type, "application/x-protobuf");
        assert_eq!(result[0].content_encoding, None);
    }

    #[test]
    fn test_kinesis_parser_invalid_utf8_in_data() {
        let event = kinesis_event(vec![vec![0x80], exporter_output("service-ok").into_bytes()]);

        let result = KinesisOtlpStdoutParser.parse(event, "test-stream").unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].source, "service-ok");
    }

    #[test]
    fn test_kinesis_parser_malformed_json_string() {
        let event = kinesis_event(vec![
            b"{\"invalid_json".to_vec(),
            exporter_output("service-fine").into_bytes(),
        ]);

        let result = KinesisOtlpStdoutParser.parse(event, "test-stream").unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].source, "service-fine");
    }

    #[test]
    fn test_kinesis_parser_empty_records() {
        let result = KinesisOtlpStdoutParser
            .parse(kinesis_event(vec![]), "test-stream")
            .unwrap();
        assert!(result.is_empty());
    }
}
