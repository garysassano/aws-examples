import { extractDataFromEnvelope } from "@aws-lambda-powertools/jmespath/envelopes";
import { Logger } from "@aws-lambda-powertools/logger";
import type { CloudWatchLogsDecodedData, KinesisStreamEvent } from "aws-lambda";

// Initialize Powertools Logger
const logger = new Logger({
  serviceName: "cross-otlp-logger",
  logLevel: "INFO",
});

export const handler = async (event: KinesisStreamEvent) => {
  logger.info("Received Kinesis event", { recordCount: event.Records.length });

  for (const record of event.Records) {
    try {
      // Use JMESPath to efficiently decode CloudWatch Logs payload from Kinesis
      // This expression:
      // 1. Reads the Kinesis record data field (contains CloudWatch Logs payload)
      // 2. Decodes and decompresses the CloudWatch Logs payload (base64 + gzip)
      // 3. Parses the resulting CloudWatch Logs JSON structure
      const logData = extractDataFromEnvelope<CloudWatchLogsDecodedData>(
        { data: record.kinesis.data },
        "powertools_base64_gzip(data) | powertools_json(@)",
      );

      // Enhance and log CloudWatch Logs data with:
      // - numberOfLogEvents: quick count for monitoring
      // - eventNumber: sequential numbering for easier reference
      // - timestamp: converted to human-readable ISO format
      logger.info("Processed CloudWatch Logs data", {
        cloudWatchLogsData: {
          ...logData,
          numberOfLogEvents: logData.logEvents.length,
          logEvents: logData.logEvents.map((logEvent, index) => ({
            eventNumber: index + 1,
            id: logEvent.id,
            timestamp: new Date(logEvent.timestamp).toISOString(),
            message: logEvent.message,
          })),
        },
      });
    } catch (error) {
      logger.error("Error processing Kinesis record", {
        error: error instanceof Error ? error.message : String(error),
        record: record,
      });
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ message: "Successfully processed Kinesis records" }),
  };
};
