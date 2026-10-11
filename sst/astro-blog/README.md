# sst-astro-blog

SST app that deploys an Astro blog to AWS.

## Prerequisites

- **_AWS:_**
  - Must have authenticated with [Default Credentials](https://docs.aws.amazon.com/cdk/v2/guide/cli.html#cli_auth) in your local environment.
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

Access the website by clicking the `<CLOUDFRONT_DISTRIBUTION_URL>`:

```sh
✓  Complete
   MyBlog: <CLOUDFRONT_DISTRIBUTION_URL>
```

## Cleanup

```sh
pnpm destroy
```

This removes the stage's resources, state, and passphrase. SST's bootstrap for the account and Region stays for other SST apps: the `sst-asset-*` and `sst-state-*` buckets, the `sst-asset` ECR repository, and the `/sst/bootstrap` SSM parameter.
