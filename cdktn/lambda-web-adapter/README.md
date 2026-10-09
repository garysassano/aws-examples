# cdktn-lambda-web-adapter

CDKTN app that runs a SvelteKit frontend and a Hono backend as Lambdaliths on AWS Lambda through the Lambda Web Adapter, with an Upstash Redis database for state.

Each app is an ordinary Node web server in an arm64 container image. The [AWS Lambda Web Adapter](https://github.com/awslabs/aws-lambda-web-adapter) runs as a Lambda extension inside the image, turns each invocation into an HTTP request to the server, and each function is exposed over a Lambda function URL.

The frontend's URL is public. The backend's URL uses `AWS_IAM` auth, so only the frontend can call it: the frontend signs each request with SigV4 using its execution role, which is the only role allowed `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` on the backend. Each function has its own execution role, and the Upstash REST token is kept in an SSM SecureString that only the backend's role can read.

## Prerequisites

- **_AWS:_**
  - Must have authenticated with [Default Credentials](https://registry.terraform.io/providers/hashicorp/aws/latest/docs#authentication-and-configuration) in your local environment.
- **_Upstash:_**
  - Must have set the `UPSTASH_EMAIL` and `UPSTASH_API_KEY` variables in your local environment.
- **_mise:_**
  - [Install mise](https://mise.jdx.dev/installing-mise.html), which manages Node, pnpm, and OpenTofu.
- **_Docker:_**
  - Must be [installed](https://docs.docker.com/get-docker/) in your system and running at deployment.

## Installation

```sh
mise install
pnpm install
pnpm gen
```

`pnpm gen` generates the AWS, Docker, and Upstash provider constructs into `.gen/`. Re-run it whenever a provider constraint in `cdktf.json` changes.

The Hono backend in `src/functions/backend` and the SvelteKit frontend in `src/functions/frontend` are standalone pnpm projects with their own lockfiles, because each one is the build context of its Docker image. Biome lints them with the rest of the app, and `pnpm check` installs and typechecks them.

## Deployment

```sh
pnpm run deploy
```

Each image is rebuilt and pushed only when a file in its build context changes.

## Cleanup

```sh
pnpm destroy
```

## Application Details

Each function shares its name with the ECR repository that holds its image, and has its own `<name>-execution-role`.

- `hono-backend` (function URL auth: `AWS_IAM`; a direct request without a signature gets `403 Forbidden`)
  - Environment variables:
    - `UPSTASH_REDIS_REST_URL` - REST endpoint of the `click-counter` database
    - `UPSTASH_REDIS_REST_TOKEN_PARAMETER` - Name of the SSM SecureString that holds the REST token, which the server reads once at startup; for local development, `UPSTASH_REDIS_REST_TOKEN` can hold the token itself
  - Endpoints:
    - `GET /` - Hello message
    - `GET /ping` - Returns `pong`; the Lambda Web Adapter's readiness check
    - `GET /api/clicks` - Returns the current click count
    - `POST /api/clicks` - Increments the click count and returns it
    - Both `/api/clicks` routes report the Redis call's duration in a `Server-Timing: redis;dur=…` header, which the frontend uses to time each hop
- `sveltekit-frontend` (function URL auth: `NONE`)
  - Environment variables:
    - `BACKEND_URL` - Function URL of `hono-backend`, declared and validated in `src/env.ts`
    - `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_SESSION_TOKEN` - The execution role's credentials, which Lambda sets and `src/server/backend.ts` signs backend requests with; without them, as in local development, it calls the backend unsigned
  - Endpoints:
    - `GET /` - Click counter, rendered on the server, with the time of each hop on the last request; the page reloads its data when the tab becomes visible again, so counts made elsewhere appear
    - The request path shows the Svelte, Hono, and Upstash Redis logos, copied unchanged from [sveltejs/branding](https://github.com/sveltejs/branding), [honojs/hono](https://github.com/honojs/hono), and [upstash/docs](https://github.com/upstash/docs) into `src/assets`
    - `POST /` - Form action that increments the counter through the backend; it is the page's default action, because function URLs reject the `/` in a named action's `?/name` query string
    - `GET /ping` - Returns `pong`; the Lambda Web Adapter's readiness check

Both servers listen on port 3000, which the images pass to the adapter as `AWS_LWA_PORT`.

The SecureString uses the AWS managed key `aws/ssm`, which any principal in the account can decrypt with, so the `ssm:GetParameter` grant is what limits who reads the token; a customer managed KMS key would add a second, key-level grant. Terraform state still holds the token, as it holds every secret Terraform manages, so keep the state private.

## Design Notes

- **Lambda-to-Lambda call.** The frontend calls the backend synchronously, so it waits, and is billed, while the backend runs, and a request can meet two cold starts. That cost is small here, about 15 ms per request, and the split is the point of the example: two independently deployed web apps. In a product, the browser would usually call the API directly with user authentication, or the frontend would talk to Redis itself.
- **Hono without the adapter.** Hono also runs on Lambda natively through `hono/aws-lambda`, which handles function URL, API Gateway, ALB, and VPC Lattice events with no adapter or HTTP server in the function. For a Hono-only service that is usually the leaner choice, with faster cold starts and an optional zip deployment, and the frontend could then call it with the Lambda Invoke API instead of a function URL. The Lambda Web Adapter earns its place with frameworks that lack an official Lambda adapter, such as SvelteKit, whose Node build runs here unchanged.

## Architecture Diagram

![Architecture Diagram](./src/assets/arch-diagram.svg)

Upstash runs the database in its own AWS account in the same Region; the backend reaches it over HTTPS through Upstash's REST API, not through your account's network.
