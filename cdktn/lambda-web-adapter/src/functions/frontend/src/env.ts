import { defineEnvVars } from "@sveltejs/kit/env";
import { building } from "$app/env";

/** A variable Lambda or the stack always sets: required when the app starts, not at build. */
const required = (name: string) => (value: string | undefined) => {
  if (building) return value ?? "";
  if (!value) throw new Error(`${name} is required`);
  return value;
};

export const variables = defineEnvVars({
  BACKEND_URL: {
    description:
      "Function URL of the Hono backend, such as https://<id>.lambda-url.<region>.on.aws/",
    // Normalized to an origin so paths can be appended.
    schema: (value) => {
      const url = required("BACKEND_URL")(value);
      return url && new URL(url).origin;
    },
  },
  AWS_REGION: {
    description: "Region the function runs in, set by Lambda",
    schema: required("AWS_REGION"),
  },
  // The execution role's temporary credentials, which Lambda sets for every function.
  // The frontend signs its calls to the backend's AWS_IAM function URL with them.
  AWS_ACCESS_KEY_ID: { schema: required("AWS_ACCESS_KEY_ID") },
  AWS_SECRET_ACCESS_KEY: { schema: required("AWS_SECRET_ACCESS_KEY") },
  AWS_SESSION_TOKEN: { schema: required("AWS_SESSION_TOKEN") },
});
