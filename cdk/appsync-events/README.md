# cdk-appsync-events

CDK app that deploys an AppSync Events API with one channel namespace backed by a Lambda function and another by a DynamoDB table.

### Related Apps

- [cdk/detect-labels](../../cdk/detect-labels) - Uses AppSync Events to push results to a browser, with no data sources.

## Prerequisites

- **_AWS:_**
  - Must have authenticated with [Default Credentials](https://docs.aws.amazon.com/cdk/v2/guide/cli.html#cli_auth) in your local environment.
  - Must have completed the [CDK bootstrapping](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html) for the target AWS environment.
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

1. Once deployed, test publishing and subscribing in both namespaces:
   - In AWS Console, `AppSync` ➜ `events-api` ➜ `Pub/Sub Editor`.
   - To **subscribe to events**:
     1. Select a namespace.
     2. Provide a channel name (e.g., `/ch1`) or leave the default (`/*`) to subscribe to all channels.
     3. Click `Subscribe`.
   - To **publish an event**:
     1. Select a namespace.
     2. Provide a channel name (e.g., `/ch1`).
     3. Leave the default JSON payload or provide a custom one.
     4. Click `Publish`.
2. For the `lambda` namespace:
   - Subscribers receive each payload wrapped by the function, as `{ processed: true, originalPayload: ... }`.
   - To see what the function logged:
     - In AWS Console, `CloudWatch` ➜ `Log groups` ➜ `/aws/lambda/events-function`.
3. For the `dynamodb` namespace:
   - Subscribers receive each payload unchanged.
   - To see what was stored:
     - In AWS Console, `DynamoDB` ➜ `Tables` ➜ `events-table`.

Clients outside the console connect to the `HttpEndpoint` and `RealtimeEndpoint` stack outputs, with the key that `aws appsync list-api-keys` returns for the API.

## Cleanup

```sh
pnpm destroy
```

## Application Details

- `lambda`
  - A channel namespace with a Lambda data source, called directly with no handler code in AppSync.
  - The [function](./src/functions/events/index.ts) routes events with the Powertools resolver, logging each subscription and wrapping each published payload.
- `dynamodb`
  - A channel namespace with a DynamoDB data source and an [`APPSYNC_JS` handler](./src/handlers/dynamodb-namespace.js).
  - Publishing writes one item per event with `type` set to `publish`, and subscribing writes one item with `type` set to `subscribe`.

## Architecture Diagram

![Architecture Diagram](./src/assets/arch-diagram.svg)
