const EXPORTERS = ["cloudwatch", "otlp", "clickhouse"] as const;

export type Exporter = (typeof EXPORTERS)[number];

// The forwarder sends the spans to this account's CloudWatch OTLP endpoint unless told
// otherwise. Pass `-c exporter=otlp` for the OTLP endpoint in your environment, or
// `-c exporter=clickhouse` for ClickHouse through the ROTel Lambda extension.
export function getExporter(input: unknown): Exporter {
  if (input === undefined) {
    return "cloudwatch";
  }

  const exporter = EXPORTERS.find((name) => name === input);
  if (exporter === undefined) {
    throw new Error(`exporter must be one of ${EXPORTERS.join(", ")}, got "${input}"`);
  }
  return exporter;
}
