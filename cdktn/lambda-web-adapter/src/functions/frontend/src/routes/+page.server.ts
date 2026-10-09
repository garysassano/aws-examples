import { error } from "@sveltejs/kit";
import { AWS_REGION, BACKEND_URL } from "$app/env/private";
import type { Actions, PageServerLoad } from "./$types";

/** Calls the backend's click counter: GET reads it, POST increments it. */
async function callCounter(
  fetch: typeof globalThis.fetch,
  method: "GET" | "POST",
): Promise<number> {
  const response = await fetch(`${BACKEND_URL}/api/clicks`, { method });
  if (!response.ok) error(502, "The click counter is unavailable");
  const body: { clicks: number } = await response.json();
  return body.clicks;
}

export const load: PageServerLoad = async ({ fetch }) => {
  const start = performance.now();
  const clicks = await callCounter(fetch, "GET");
  return {
    clicks,
    // Frontend to backend to Redis and back, as this function measured it.
    roundTripMs: Math.round(performance.now() - start),
    region: AWS_REGION,
  };
};

export const actions: Actions = {
  // A named action posts to `?/name`, and Lambda function URLs reject that unencoded
  // slash with InvalidQueryStringException; the default action posts to the page itself.
  // `use:enhance` reruns `load` after it, so the page shows the new count.
  default: async ({ fetch }) => {
    await callCounter(fetch, "POST");
  },
};
