import { AWS_REGION } from "$app/env/private";
import { callCounter } from "../server/backend.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ fetch }) => ({
  ...(await callCounter(fetch, "GET")),
  region: AWS_REGION,
});

export const actions: Actions = {
  // The default action posts to the page itself and returns the new count, so the page
  // needs no second request to reload it.
  default: async ({ fetch }) => callCounter(fetch, "POST"),
};
