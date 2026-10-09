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
  AWS_REGION: {
    description: "Region the function runs in, set by Lambda; unset in local development",
    schema: (value) => value,
  },
  // The execution role's temporary credentials, which Lambda sets for every function.
  // The frontend signs its calls to the backend's AWS_IAM function URL with them;
  // without them, as in local development, it calls the backend unsigned.
  AWS_ACCESS_KEY_ID: { schema: (value) => value },
  AWS_SECRET_ACCESS_KEY: { schema: (value) => value },
  AWS_SESSION_TOKEN: { schema: (value) => value },
});
