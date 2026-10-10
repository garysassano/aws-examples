# cdk-eventbridge-webhooks-momento

CDK app that demonstrates how to use Amazon EventBridge to send webhook events to Momento.

> [!NOTE]
> Momento retired its free tier in late 2025, so running this example needs a paid Momento account.

## Prerequisites

- **_AWS:_**
  - Must have authenticated with [Default Credentials](https://docs.aws.amazon.com/cdk/v2/guide/cli.html#cli_auth) in your local environment.
  - Must have completed the [CDK bootstrapping](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html) for the target AWS environment.
- **_Momento:_**
  - Must have created a cache named `momento-eventbridge-cache` in your Momento account.
  - Must have stored your Momento API key in AWS Secrets Manager as a secret named `momento-api-key`, so the key never appears in the CloudFormation template:

    ```sh
    aws secretsmanager create-secret --name momento-api-key --secret-string "$MOMENTO_API_KEY"
    ```

  - Must have set the `MOMENTO_API_ENDPOINT` variable, your cache region's HTTP API endpoint, in your local environment.
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

## Usage

Both demo apps write to the `weather-stats-table` DynamoDB table and read the Momento cache and topic directly.

### CLI App

Uses your default AWS credentials and needs `MOMENTO_API_KEY` in the environment or in `src/demo/cli/.env`.

```sh
pnpm -C src/demo/cli start
```

### Web App

A browser has no default AWS credential chain, so the Vite dev server reads `VITE_AWS_REGION`, `VITE_AWS_ACCESS_KEY_ID`, `VITE_AWS_SECRET_ACCESS_KEY`, `VITE_AWS_SESSION_TOKEN` and `VITE_MOMENTO_API_KEY` from `src/demo/web/.env.local`. These end up in the page bundle, so run the app only locally.

```sh
pnpm -C src/demo/web dev
```

## Cleanup

```sh
pnpm destroy
```

## Architecture Diagram

![Architecture Diagram](./src/assets/arch-diagram.svg)
