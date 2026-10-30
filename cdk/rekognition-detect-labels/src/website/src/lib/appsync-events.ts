import type { Config, Result } from "@/types";

const RESULT_TIMEOUT_MS = 60_000;

/** Encodes the authorization headers as the WebSocket subprotocol AppSync Events expects. */
function authProtocol(headers: Record<string, string>): string {
  const encoded = btoa(JSON.stringify(headers))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `header-${encoded}`;
}

export interface Subscription {
  /** Resolves with the first result published to the channel. */
  result: Promise<Result>;
  close: () => void;
}

/**
 * Subscribes to an AppSync Events channel with the API key and resolves once the subscription is
 * confirmed, so an event published afterwards cannot be missed.
 */
export function subscribe(config: Config, channel: string): Promise<Subscription> {
  const authorization = { host: config.eventApiHttpDns, "x-api-key": config.eventApiKey };
  const socket = new WebSocket(`wss://${config.eventApiRealtimeDns}/event/realtime`, [
    "aws-appsync-event-ws",
    authProtocol(authorization),
  ]);
  const id = crypto.randomUUID();

  return new Promise((resolve, reject) => {
    let resolveResult: (result: Result) => void;
    let rejectResult: (error: Error) => void;
    const result = new Promise<Result>((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });
    // The caller only awaits the result after uploading; don't report a failure meanwhile.
    result.catch(() => {});

    const timeout = setTimeout(
      () => rejectResult(new Error("Timed out waiting for the result")),
      RESULT_TIMEOUT_MS,
    );
    const close = () => {
      clearTimeout(timeout);
      socket.close();
    };

    socket.onopen = () => socket.send(JSON.stringify({ type: "connection_init" }));
    socket.onerror = () => {
      const error = new Error("The result connection failed");
      reject(error);
      rejectResult(error);
    };
    socket.onclose = () => rejectResult(new Error("The result connection closed"));
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(String(data));
      switch (message.type) {
        case "connection_ack":
          socket.send(JSON.stringify({ type: "subscribe", id, channel, authorization }));
          break;
        case "subscribe_success":
          resolve({ result, close });
          break;
        case "subscribe_error":
        case "error":
          reject(new Error("Subscribing to the result failed"));
          rejectResult(new Error("Subscribing to the result failed"));
          break;
        case "data":
          resolveResult(JSON.parse(message.event));
          break;
      }
    };
  });
}
