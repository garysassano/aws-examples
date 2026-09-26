# cdk-lambda-otel-code-instrumentation-node

CDK app showcasing OpenTelemetry [code-based instrumentation](https://opentelemetry.io/docs/concepts/instrumentation/code-based/) for AWS Lambda functions using the Node.js runtime. Implements [OpenTelemetry JS SDK 2.x](https://opentelemetry.io/blog/2025/otel-js-sdk-2-0/) for generating the traces which are sent to Honeycomb.

### Related Apps

- [cdk/lambda-otel-auto-instrumentation-node](../../cdk/lambda-otel-auto-instrumentation-node) - Uses OpenTelemetry auto instrumentation instead of code.

## Prerequisites

- **_AWS:_**
  - Must have authenticated with [Default Credentials](https://docs.aws.amazon.com/cdk/v2/guide/cli.html#cli_auth) in your local environment.
  - Must have completed the [CDK bootstrapping](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html) for the target AWS environment.
- **_Honeycomb:_**
  - Must have set the `HONEYCOMB_API_KEY` variable in your local environment.
- **_mise:_**
  - [Install mise](https://mise.jdx.dev/installing-mise.html), which manages the required toolchain.

## Installation

```sh
mise install
pnpm install
```

## Deployment

```sh
pnpm run deploy
```

## Cleanup

```sh
pnpm destroy
```
