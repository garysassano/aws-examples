# cdk-cross-account-cwl-sub-org

CDK app showcasing how to use [CloudWatch Logs cross‑account account-level subscriptions](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CrossAccountSubscriptions-Kinesis-Account.html) for sending OTel traces to a centralized location.

## Prerequisites

- **_AWS:_**
  - Must have completed the steps detailed in the [Configuration](#configuration) section.
- **_mise:_**
  - [Install mise](https://mise.jdx.dev/installing-mise.html), which manages the required toolchain.

## Configuration

Set the following variables in your local environment:

- `CDK_ACCOUNT_SRC` - The AWS account ID for the source stack (e.g. `123456789012`)
- `CDK_ACCOUNT_TRG` - The AWS account ID for the target stack (e.g. `123456789012`)
- `CDK_REGION_SHARED` - The AWS region for both source and target stacks (e.g. `us-east-1`)
- `AWS_ORG_ID_SHARED` - The AWS organization ID used for cross-account permissions (e.g. `o-12345abcde`)

After that, complete the [CDK bootstrapping](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html) process for both the `SRC` and `TRG` accounts.

1. Execute the command below with a user having admin privileges in the `SRC` account:

   ```sh
   cdk bootstrap aws://$CDK_ACCOUNT_SRC/$CDK_REGION_SHARED
   ```

2. Execute the command below with a user having admin privileges in the `TRG` account:

   ```sh
   cdk bootstrap aws://$CDK_ACCOUNT_TRG/$CDK_REGION_SHARED --trust $CDK_ACCOUNT_SRC --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess
   ```

## Installation

```sh
mise install
pnpm install
```

## Deployment

Execute the command below as admin of the `SRC` account:

```sh
pnpm run deploy --all --require-approval never
```

## Cleanup

Execute the command below as admin of the `SRC` account:

```sh
pnpm destroy --all --force
```

## Architecture Diagram

![Architecture Diagram](./src/assets/arch-diagram.svg)
