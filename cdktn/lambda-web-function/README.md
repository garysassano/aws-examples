# cdktn-lambda-web-function

CDKTN app that runs a SvelteKit frontend and a Hono backend as [AWS Lambda Web Functions](https://docs.aws.amazon.com/lambda/latest/dg/web-functions.html), with an Upstash Redis database for state. It is the same app as [`cdktn-lambda-web-adapter`](../lambda-web-adapter), with the adapter replaced by Lambda's own HTTP-native form factor.

Each app is an ordinary Node web server. Lambda starts it, waits for it to listen on the address in `AWS_LAMBDA_HTTP_ENDPOINT`, and sends it HTTP requests directly: there is no adapter, no event-to-HTTP translation, and no container image. Each function is a `.zip` package in a versioned S3 bucket, an immutable revision that pins that package's object version, and an HTTPS endpoint that routes to the revision.

The frontend's endpoint is public (`ApplicationManaged`). The backend's endpoint uses `IamAuth`, so only the frontend can call it: the frontend signs each request with SigV4 using its execution role, and that role is the only one granted `lambda:InvokeWebFunctionEndpoint` on the backend's endpoint. Each function has its own execution role, and the Upstash REST token is kept in an SSM SecureString that only the backend's role can read.

## Prerequisites

- **_AWS:_**
  - Must have authenticated with [Default Credentials](https://registry.terraform.io/providers/hashicorp/aws/latest/docs#authentication-and-configuration) in your local environment.
  - Must deploy to a Region that offers Web Functions. The stack uses `eu-west-1`; at launch the others are `us-east-1`, `us-east-2`, `us-west-2`, and `ap-northeast-1`.
- **_Upstash:_**
  - Must have set the `UPSTASH_EMAIL` and `UPSTASH_API_KEY` variables in your local environment.
- **_mise:_**
  - [Install mise](https://mise.jdx.dev/installing-mise.html), which manages Node, pnpm, and OpenTofu.

## Installation

```sh
mise install
pnpm install
pnpm gen
```

`pnpm gen` generates the AWS, AWS Cloud Control, and Upstash provider constructs into `.gen/`. Re-run it whenever a provider constraint in `cdktf.json` changes. Web Functions are only in the Cloud Control provider (`hashicorp/awscc` 1.106.0 and later) so far, so the stack uses it for the function, its revision, and its endpoint, and the AWS provider for everything else. The Cloud Control provider is large, and generating it takes about a minute.

The Hono backend in `src/functions/backend` and the SvelteKit frontend in `src/functions/frontend` are standalone pnpm projects with their own lockfiles. Synth installs and builds each one into its `dist/` directory, which becomes the function's package, much as `NodejsFunction` bundles in AWS CDK. Biome lints them with the rest of the app, and `pnpm check` installs and typechecks them.

## Deployment

```sh
pnpm run deploy
```

Each package is uploaded, and its function gets a new revision, only when the package's contents change. SvelteKit names each build after a hash of its source rather than the time, so an unchanged frontend builds a byte-identical package.

## Cleanup

```sh
pnpm destroy
```

Destroy removes the functions, their code buckets with every object version, and their log groups. Lambda cannot recreate the log groups afterwards, because the execution roles may write to them but not create them.

## Application Details

Each function's code bucket is named `<name>-code-<suffix>`, and its execution role `<name>-web-execution-role`, so the roles don't clash with the `lambda-web-adapter` example's in the same account. Each endpoint is named `live`, is a `HomeRegion` endpoint, and sends all traffic to the function's latest revision.

- `hono-backend` (endpoint auth: `IamAuth`; Lambda rejects a direct request that isn't signed by an allowed principal)
  - Environment variables:
    - `UPSTASH_REDIS_REST_URL` - REST endpoint of the `click-counter` database
    - `UPSTASH_REDIS_REST_TOKEN_PARAMETER` - Name of the SSM SecureString that holds the REST token, which the server reads once at startup
    - `AWS_LAMBDA_NODEJS_ENTRYPOINT` - `index.mjs`, the esbuild bundle, since Lambda loads `index.js` by default
  - Endpoints:
    - `GET /` - Hello message
    - `GET /api/clicks` - Returns the current click count, with the Redis call's duration in a `Server-Timing: redis;dur=…` header
    - `POST /api/clicks` - Increments the click count and returns it, with the same header
- `sveltekit-frontend` (endpoint auth: `ApplicationManaged`)
  - Environment variables:
    - `BACKEND_URL` - Endpoint URL of `hono-backend`, declared and validated in `src/env.ts`
    - `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_SESSION_TOKEN` - The execution role's credentials, which Lambda sets and `src/server/backend.ts` signs backend requests with
  - Endpoints:
    - `GET /` - Click counter, rendered on the server
    - `POST /` - Form action that increments the counter through the backend

Lambda treats an environment as ready as soon as its port accepts connections, so neither app needs the `/ping` readiness route that the adapter version has. The backend reads its token before it listens, so it never takes a request before Redis is usable. adapter-node listens on `HOST` and `PORT`, so the frontend's package has a small `index.js` (`lambda/index.js`) that sets them from `AWS_LAMBDA_HTTP_ENDPOINT` and then starts the server.

Signed requests to an `IamAuth` endpoint must carry an `X-Amz-Content-SHA256` header, which Lambda takes as the payload hash. The frontend's requests have no body, so it sends `UNSIGNED-PAYLOAD`.

The page draws the request path from SvelteKit through Hono to Upstash Redis with each hop's time on the last request, split using the backend's `Server-Timing` header. It reloads its data when its tab is shown again or the browser regains focus, so counts made elsewhere appear. The Svelte, Hono, and Upstash Redis logos are copied unchanged from [sveltejs/branding](https://github.com/sveltejs/branding), [honojs/hono](https://github.com/honojs/hono), and [upstash/docs](https://github.com/upstash/docs) into `src/assets`.

The SecureString uses the AWS managed key `aws/ssm`, which any principal in the account can decrypt with, so the `ssm:GetParameter` grant is what limits who reads the token; a customer managed KMS key would add a second, key-level grant. Terraform state still holds the token, as it holds every secret Terraform manages, so keep the state private.

## Architecture Diagram

![Architecture Diagram](./src/assets/arch-diagram.svg)

### Design Notes

- **Compared with the Lambda Web Adapter.** Both run an unchanged Node server. Here Lambda runs it natively: each environment serves many requests at once (up to `maxConcurrencyPerEnvironment`), billing counts active CPU time plus memory for the environment's lifetime rather than each request's duration, and responses stream without extra configuration. In exchange, Web Functions support only Node.js 24 on arm64 with 2 GB of memory, take only `.zip` packages from S3, have no Lambda extensions, and are in five Regions at launch. The adapter still covers other runtimes, container images, and every Region.
- **Revisions.** A revision is immutable, so every code or configuration change creates a new one. The stack creates it before deleting the old one, and the endpoint's revision weights point at it, so traffic always has a revision to go to. Canary splits between two revisions are possible with `revision_weights`, but a stack that replaces revisions on every change makes them awkward to hold.
- **Lambda-to-Lambda call.** The frontend calls the backend synchronously, so a request can meet two cold starts. Waiting on the backend uses little of the frontend's CPU, and its environment keeps serving other requests meanwhile, so the split costs less than it does with the adapter. In a product, the browser would usually call the API directly with user authentication, or the frontend would talk to Redis itself.
