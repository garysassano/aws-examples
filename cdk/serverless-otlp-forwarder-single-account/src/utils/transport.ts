const TRANSPORTS = ["logs-subscription", "kinesis"] as const;

export type Transport = (typeof TRANSPORTS)[number];

// The spans reach the forwarder through an account-level CloudWatch Logs subscription
// filter unless told otherwise. Pass `-c transport=kinesis` to have an extension put them
// into a Kinesis data stream instead.
export function getTransport(input: unknown): Transport {
  if (input === undefined) {
    return "logs-subscription";
  }

  const transport = TRANSPORTS.find((name) => name === input);
  if (transport === undefined) {
    throw new Error(`transport must be one of ${TRANSPORTS.join(", ")}, got "${input}"`);
  }
  return transport;
}
