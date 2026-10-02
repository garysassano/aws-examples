use aws_sdk_eventbridgev2::primitives::Blob;
use aws_sdk_eventbridgev2::types::{PutRawEventsRequestEntry, PutRawEventsSystemMetadata};
use base64::{Engine, engine::general_purpose};
use lambda_extension::{Error, tracing};
use otlp_stdout_span_exporter::ExporterOutput;

// PutRawEvents accepts at most 100 entries per request.
pub const MAX_ENTRIES_PER_REQUEST: usize = 100;

// Payload limit for a single event. Kept at the Kinesis record limit the extension
// started from; the Custom Event Bus does not document a per-event limit.
pub const MAX_EVENT_SIZE_BYTES: usize = 1_048_576;

// The bus stores and delivers the bytes untouched, so the forwarder reads the
// gzipped OTLP protobuf directly instead of a JSON line wrapping it.
pub const CONTENT_TYPE: &str = "application/octet-stream";

// Metadata keys that carry what the JSON line held around the payload. The bus
// cannot filter on opaque bytes, so subscribers route on these instead.
pub const METADATA_SOURCE: &str = "otlp.source";
pub const METADATA_CONTENT_TYPE: &str = "otlp.content-type";
pub const METADATA_CONTENT_ENCODING: &str = "otlp.content-encoding";

#[derive(Default)]
pub struct EventBusBatch {
    pub entries: Vec<PutRawEventsRequestEntry>,
}

impl EventBusBatch {
    /// Adds one JSON line written by OtlpStdoutSpanExporter, publishing its payload as raw bytes.
    pub fn add_record(&mut self, record: String) -> Result<(), Error> {
        let output: ExporterOutput = serde_json::from_str(&record)
            .map_err(|e| Error::from(format!("Failed to parse exporter output: {}", e)))?;

        let payload = if output.base64 {
            general_purpose::STANDARD
                .decode(&output.payload)
                .map_err(|e| Error::from(format!("Failed to decode payload: {}", e)))?
        } else {
            output.payload.into_bytes()
        };

        if payload.len() > MAX_EVENT_SIZE_BYTES {
            tracing::warn!(
                "Payload size {} bytes exceeds maximum size of {} bytes, skipping",
                payload.len(),
                MAX_EVENT_SIZE_BYTES
            );
            return Ok(());
        }

        let system_metadata = PutRawEventsSystemMetadata::builder()
            .content_type(CONTENT_TYPE)
            .build()
            .map_err(|e| Error::from(format!("Failed to build system metadata: {}", e)))?;

        let entry = PutRawEventsRequestEntry::builder()
            .data(Blob::new(payload))
            .system_metadata(system_metadata)
            .metadata(METADATA_SOURCE, output.source)
            .metadata(METADATA_CONTENT_TYPE, output.content_type)
            .metadata(METADATA_CONTENT_ENCODING, output.content_encoding)
            .build()
            .map_err(|e| Error::from(format!("Failed to build event entry: {}", e)))?;

        self.entries.push(entry);
        Ok(())
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // A base64-encoded, gzipped, empty OTLP ExportTraceServiceRequest.
    const VALID_TEST_PAYLOAD_STRING: &str = "H4sIAAAAAAAAAAMAAAAAAAAAAAA=";

    fn exporter_output(payload: &str) -> String {
        json!({
            "__otel_otlp_stdout": "otlp-stdout-span-exporter@0.17.1",
            "source": "service-a",
            "endpoint": "http://localhost:4318/v1/traces",
            "method": "POST",
            "payload": payload,
            "content-type": "application/x-protobuf",
            "content-encoding": "gzip",
            "base64": true
        })
        .to_string()
    }

    #[test]
    fn test_add_record_publishes_raw_payload() {
        let mut batch = EventBusBatch::default();
        batch
            .add_record(exporter_output(VALID_TEST_PAYLOAD_STRING))
            .unwrap();

        assert_eq!(batch.entries.len(), 1);
        let entry = &batch.entries[0];
        let expected = general_purpose::STANDARD
            .decode(VALID_TEST_PAYLOAD_STRING)
            .unwrap();
        assert_eq!(entry.data().as_ref(), expected.as_slice());
        assert_eq!(
            entry.system_metadata().unwrap().content_type(),
            CONTENT_TYPE
        );
        let metadata = entry.metadata().unwrap();
        assert_eq!(metadata[METADATA_SOURCE], "service-a");
        assert_eq!(metadata[METADATA_CONTENT_TYPE], "application/x-protobuf");
        assert_eq!(metadata[METADATA_CONTENT_ENCODING], "gzip");
    }

    #[test]
    fn test_add_record_rejects_invalid_json() {
        let mut batch = EventBusBatch::default();
        assert!(batch.add_record("not json".to_string()).is_err());
        assert!(batch.is_empty());
    }

    #[test]
    fn test_add_record_too_large() {
        let mut batch = EventBusBatch::default();
        let large = general_purpose::STANDARD.encode(vec![0u8; MAX_EVENT_SIZE_BYTES + 1]);
        assert!(batch.add_record(exporter_output(&large)).is_ok());
        assert!(batch.is_empty());
    }

    #[test]
    fn test_clear_batch() {
        let mut batch = EventBusBatch::default();
        batch
            .add_record(exporter_output(VALID_TEST_PAYLOAD_STRING))
            .unwrap();
        batch.clear();
        assert!(batch.is_empty());
    }
}
