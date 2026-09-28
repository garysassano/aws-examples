use anyhow::Result;
use aws_lambda_events::event::cloudwatch_logs::LogsEvent;
use otlp_stdout_span_exporter::ExporterOutput;
use serverless_otlp_forwarder_core::core_parser::EventParser;
use serverless_otlp_forwarder_core::telemetry::TelemetryData;

// Define a local struct for parsing CloudWatch Logs events containing OTLP stdout format.
pub struct CloudWatchLogsOtlpStdoutParser;

impl EventParser for CloudWatchLogsOtlpStdoutParser {
    type EventInput = LogsEvent;

    fn parse(
        &self,
        event_payload: Self::EventInput,
        _log_group: &str,
    ) -> Result<Vec<TelemetryData>> {
        let log_events = event_payload.aws_logs.data.log_events;
        let mut telemetry_items = Vec::with_capacity(log_events.len());

        for log_event in log_events {
            let log_record_str = &log_event.message;
            tracing::debug!(
                "Received log record string for OTLP stdout processing: {}",
                log_record_str
            );

            let record: ExporterOutput = match serde_json::from_str(log_record_str) {
                Ok(output) => output,
                Err(err) => {
                    tracing::warn!(
                        "Failed to parse log record as ExporterOutput JSON: {}. Error details: {}. Skipping record.",
                        log_record_str,
                        err
                    );
                    continue; // Skip this log event if it doesn't parse to ExporterOutput
                }
            };

            tracing::debug!(
                "Successfully parsed log record as ExporterOutput with version: {}",
                record.version
            );

            // TelemetryData::from_log_record is now part of the core library
            // and handles the conversion from ExporterOutput to the core TelemetryData format.
            match TelemetryData::from_log_record(record) {
                Ok(telemetry_data) => telemetry_items.push(telemetry_data),
                Err(e) => {
                    tracing::warn!(
                        "Failed to convert ExporterOutput to TelemetryData: {}. Skipping record.",
                        e
                    );
                }
            }
        }
        Ok(telemetry_items)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_lambda_events::event::cloudwatch_logs::LogEntry;
    use serde_json::json;

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
        // from_log_record decodes and decompresses the payload
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
}
