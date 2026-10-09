import { error } from "@sveltejs/kit";
import { AWS_REGION, BACKEND_URL } from "$app/env/private";
import type { Actions, PageServerLoad } from "./$types";

export interface Hop {
  from: string;
  to: string;
  ms: number;
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
async function callCounter(
  fetch: typeof globalThis.fetch,
  method: "GET" | "POST",
): Promise<{ clicks: number; hops: Hop[] }> {
  const start = performance.now();
  const response = await fetch(`${BACKEND_URL}/api/clicks`, { method });
  if (!response.ok) error(502, "The click counter is unavailable");
  const body: { clicks: number } = await response.json();
  const roundTrip = performance.now() - start;
  const redis = serverTiming(response.headers.get("server-timing"), "redis") ?? 0;

  return {
    clicks: body.clicks,
    hops: [
      { from: "SvelteKit", to: "Hono", ms: Math.round(roundTrip - redis) },
      { from: "Hono", to: "Upstash Redis", ms: Math.round(redis) },
    ],
  };
}

export const load: PageServerLoad = async ({ fetch }) => ({
  ...(await callCounter(fetch, "GET")),
  region: AWS_REGION,
});

export const actions: Actions = {
  // A named action posts to `?/name`, and Lambda function URLs reject that unencoded
  // slash with InvalidQueryStringException; the default action posts to the page itself.
  // It returns the new count, so the page needs no second request to reload it.
  default: async ({ fetch }) => callCounter(fetch, "POST"),
};
