import type { Config, Result } from "@/types";

// How long connecting and subscribing may take before the page gives up.
const SUBSCRIBE_TIMEOUT_MS = 15_000;

/** Encodes the authorization headers as the WebSocket subprotocol AppSync Events expects. */
function authProtocol(headers: Record<string, string>): string {
  const encoded = btoa(JSON.stringify(headers))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `header-${encoded}`;
}

export interface Subscription {
  /** Resolves with the first result published to the channel, or rejects after `timeoutMs`. */
  waitForResult: (timeoutMs: number) => Promise<Result>;
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

    let timeout = setTimeout(
      () => fail("Timed out subscribing to the result"),
      SUBSCRIBE_TIMEOUT_MS,
    );
    const close = () => {
      clearTimeout(timeout);
      socket.close();
    };
    // Fails whichever step is still pending: subscribing, or waiting for the result.
    const fail = (message: string) => {
      const error = new Error(message);
      reject(error);
      rejectResult(error);
      close();
    };
    const waitForResult = (timeoutMs: number) => {
      // Counted from here, after the upload, so a slow upload doesn't eat into the detector's time.
      clearTimeout(timeout);
      timeout = setTimeout(() => fail("Timed out waiting for the result"), timeoutMs);
      return result;
    };

    socket.onopen = () => socket.send(JSON.stringify({ type: "connection_init" }));
    socket.onerror = () => fail("The result connection failed");
    socket.onclose = () => fail("The result connection closed");
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(String(data));
      switch (message.type) {
        case "connection_ack":
          socket.send(JSON.stringify({ type: "subscribe", id, channel, authorization }));
          break;
        case "subscribe_success":
          clearTimeout(timeout);
          resolve({ waitForResult, close });
          break;
        case "connection_error":
        case "subscribe_error":
        case "error":
          fail("Subscribing to the result failed");
          break;
        case "broadcast_error":
          fail("Receiving the result failed");
          break;
        case "data":
          resolveResult(JSON.parse(message.event));
          break;
      }
    };
  });
}
