const EXPORTERS = ["otlp", "clickhouse", "cloudwatch"] as const;

export type Exporter = (typeof EXPORTERS)[number];

// Pass `-c exporter=clickhouse` to send the spans to ClickHouse through the ROTel Lambda
// extension, or `-c exporter=cloudwatch` to send them to this account's CloudWatch OTLP
// endpoint; otherwise the forwarder sends them to the OTLP endpoint in your environment.
export function getExporter(input: unknown): Exporter {
  if (input === undefined) {
    return "otlp";
  }

  const exporter = EXPORTERS.find((name) => name === input);
  if (exporter === undefined) {
    throw new Error(`exporter must be one of ${EXPORTERS.join(", ")}, got "${input}"`);
  }
  return exporter;
}
