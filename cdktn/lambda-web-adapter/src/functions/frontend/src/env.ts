import { defineEnvVars } from "@sveltejs/kit/env";
import { building } from "$app/env";

export const variables = defineEnvVars({
  BACKEND_URL: {
    description:
      "Function URL of the Hono backend, such as https://<id>.lambda-url.<region>.on.aws/",
    // Required at runtime only, and normalized to an origin so paths can be appended.
    schema: (value) => {
      if (building) return value;
      if (!value) throw new Error("BACKEND_URL is required");
      return new URL(value).origin;
    },
  },
});
