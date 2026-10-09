import { Hash } from "@smithy/hash-node";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import { error } from "@sveltejs/kit";
import {
  AWS_ACCESS_KEY_ID,
  AWS_REGION,
  AWS_SECRET_ACCESS_KEY,
  AWS_SESSION_TOKEN,
  BACKEND_URL,
} from "$app/env/private";

export interface Hop {
  to: string;
  /** Shown before `to` when the card is wide enough. */
  vendor?: string;
  ms: number;
}

// The backend's function URL uses AWS_IAM auth, so requests must carry a SigV4
// signature for the `lambda` service from a role allowed to invoke it.
const signer = new SignatureV4({
  service: "lambda",
  region: AWS_REGION,
  sha256: Hash.bind(null, "sha256"),
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
    sessionToken: AWS_SESSION_TOKEN,
  },
});

async function signedHeaders(url: URL, method: string): Promise<Record<string, string>> {
  const { headers } = await signer.sign(
    new HttpRequest({
      method,
      protocol: url.protocol,
      hostname: url.hostname,
      path: url.pathname,
      headers: { host: url.host },
    }),
  );
  // fetch sets Host itself, to the same value that was signed.
  const { host: _, ...rest } = headers;
  return rest;
}

/** The `dur` of one metric in a `Server-Timing` header, in milliseconds. */
function serverTiming(header: string | null, name: string): number | undefined {
  const metric = header
    ?.split(",")
    .map((entry) => entry.trim().split(";"))
    .find(([metricName]) => metricName === name);
  const duration = metric?.find((param) => param.trim().startsWith("dur="));
  return duration === undefined ? undefined : Number(duration.trim().slice(4));
}

/**
 * Calls the backend's click counter (GET reads it, POST increments it) and times each
 * hop: the backend reports its Redis call in `Server-Timing`, and the rest of the round
 * trip is the network and Hono's own handling.
 */
export async function callCounter(
  fetch: typeof globalThis.fetch,
  method: "GET" | "POST",
): Promise<{ clicks: number; hops: Hop[] }> {
  const url = new URL("/api/clicks", BACKEND_URL);
  const start = performance.now();
  const response = await fetch(url, { method, headers: await signedHeaders(url, method) });
  if (!response.ok) error(502, "The click counter is unavailable");
  const body: { clicks: number } = await response.json();
  const roundTrip = performance.now() - start;
  const redis = serverTiming(response.headers.get("server-timing"), "redis") ?? 0;

  return {
    clicks: body.clicks,
    hops: [
      { to: "Hono", ms: Math.round(roundTrip - redis) },
      { to: "Redis", vendor: "Upstash", ms: Math.round(redis) },
    ],
  };
}
