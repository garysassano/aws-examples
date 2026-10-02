const TRANSPORTS = ["logs-destination", "logs-centralization", "event-bus"] as const;

export type Transport = (typeof TRANSPORTS)[number];

// Pass `-c transport=<name>` to choose how the spans travel from the source account to
// the target account. The three transports cannot run side by side: the forwarder would
// receive every span more than once.
export function getTransport(input: unknown): Transport {
  if (input === undefined) {
    throw new Error(`transport is required: pass -c transport=<${TRANSPORTS.join("|")}>`);
  }

  const transport = TRANSPORTS.find((name) => name === input);
  if (transport === undefined) {
    throw new Error(`transport must be one of ${TRANSPORTS.join(", ")}, got "${input}"`);
  }
  return transport;
}

// Names both stacks agree on, since a stack cannot reference another account's resources.
export const DESTINATION_NAME = "otlp-destination";
export const EVENT_BUS_NAME = "otlp-bus";
export const FORWARDER_NAME = "otlp-forwarder";
