const EXPORTERS = ["otlp", "clickhouse"] as const;

export type Exporter = (typeof EXPORTERS)[number];

// Pass `-c exporter=clickhouse` to send the spans to ClickHouse through the ROTel Lambda
// extension; otherwise the forwarder sends them to the OTLP endpoint in your environment.
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
