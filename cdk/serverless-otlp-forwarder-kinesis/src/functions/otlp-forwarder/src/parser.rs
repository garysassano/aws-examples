use anyhow::Result;
use aws_lambda_events::event::kinesis::KinesisEvent;
use otlp_stdout_span_exporter::ExporterOutput;
use serverless_otlp_forwarder_core::core_parser::EventParser;
use serverless_otlp_forwarder_core::telemetry::TelemetryData;

pub struct KinesisOtlpStdoutParser;

impl EventParser for KinesisOtlpStdoutParser {
    type EventInput = KinesisEvent;

    fn parse(
        &self,
        event_payload: Self::EventInput,
        _stream_name: &str,
    ) -> Result<Vec<TelemetryData>> {
        let records = event_payload.records;
        let mut telemetry_items = Vec::with_capacity(records.len());

        for kinesis_event_record in records {
            // Each record holds one JSON line written by OtlpStdoutSpanExporter.
            let data = &kinesis_event_record.kinesis.data.0;
            tracing::debug!(
                "Received Kinesis record (JSON string): {}",
                String::from_utf8_lossy(data)
            );

            let exporter_output_record: ExporterOutput = match serde_json::from_slice(data) {
                Ok(output) => output,
                Err(err) => {
                    tracing::warn!(
                        "Failed to parse Kinesis record as ExporterOutput JSON: {}. Error details: {}. Skipping record.",
                        String::from_utf8_lossy(data),
                        err
                    );
                    continue;
                }
            };

            tracing::debug!(
                "Successfully parsed Kinesis record as ExporterOutput with version: {}",
                exporter_output_record.version
            );

            match TelemetryData::from_log_record(exporter_output_record) {
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
    use aws_lambda_events::event::kinesis::KinesisEventRecord;
    use serde_json::json;

    // A base64-encoded, gzipped, empty OTLP ExportTraceServiceRequest.
    const VALID_TEST_PAYLOAD_STRING: &str = "H4sIAAAAAAAAAAMAAAAAAAAAAAA=";

    // A record in the otlp_stdout_span_exporter::ExporterOutput format.
    fn exporter_output(source: &str) -> Vec<u8> {
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
        .into_bytes()
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
    fn test_kinesis_otlp_stdout_parser_success() {
        let event = kinesis_event(vec![
            exporter_output("service-c"),
            exporter_output("service-d"),
        ]);

        let result = KinesisOtlpStdoutParser.parse(event, "test-stream").unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].source, "service-c");
        assert_eq!(result[1].source, "service-d");
        assert_eq!(result[0].content_type, "application/x-protobuf");
        assert_eq!(result[0].content_encoding, None);
    }

    #[test]
    fn test_kinesis_otlp_stdout_parser_invalid_utf8_in_data() {
        let event = kinesis_event(vec![vec![0x80], exporter_output("service-ok")]);

        let result = KinesisOtlpStdoutParser.parse(event, "test-stream").unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].source, "service-ok");
    }

    #[test]
    fn test_kinesis_otlp_stdout_parser_malformed_json_string() {
        let event = kinesis_event(vec![
            b"{\"invalid_json".to_vec(),
            exporter_output("service-fine"),
        ]);

        let result = KinesisOtlpStdoutParser.parse(event, "test-stream").unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].source, "service-fine");
    }

    #[test]
    fn test_kinesis_otlp_stdout_parser_empty_records() {
        let result = KinesisOtlpStdoutParser
            .parse(kinesis_event(vec![]), "test-stream")
            .unwrap();
        assert!(result.is_empty());
    }
}
