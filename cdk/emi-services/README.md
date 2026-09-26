# cdk-emi-services

CDK app that deploys two ECS web services with an EMI (ECS Managed Instances) capacity provider. This repository demonstrates [Amazon ECS Managed Instances](https://aws.amazon.com/about-aws/whats-new/2025/09/amazon-ecs-managed-instances/).

## Prerequisites

- **_AWS:_**
  - Must have authenticated with [Default Credentials](https://docs.aws.amazon.com/cdk/v2/guide/cli.html#cli-auth) in your local environment.
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

## Cleanup

```sh
pnpm destroy
```
