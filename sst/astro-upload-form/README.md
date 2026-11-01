# sst-astro-upload-form

SST app that deploys an Astro website with a form for uploading files to an S3 bucket.

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

## Development

```sh
pnpm sst dev
```

SST deploys the bucket and a stub of the `Presign` function that runs your local code, then starts `astro dev` at `http://localhost:4321` with `PUBLIC_PRESIGN_URL` set; plain `pnpm dev` starts Astro without it, so uploads fail. Dev mode doesn't deploy the website, so on a stage you've deployed it replaces the site; pass `--stage dev` to keep them apart.

## Deployment

```sh
pnpm run deploy
```

## Usage

Access the website by clicking the `<CLOUDFRONT_DISTRIBUTION_URL>`:

```sh
✓  Complete
   Presign: <FUNCTION_URL>
   MyWebsite: <CLOUDFRONT_DISTRIBUTION_URL>
```

## Cleanup

```sh
pnpm destroy
```

This removes the stage's resources, including the bucket and its uploads, along with the stage's state and passphrase. SST's bootstrap for the account and Region stays for other SST apps: the `sst-asset-*` and `sst-state-*` buckets, the `sst-asset` ECR repository, the `/sst/bootstrap` SSM parameter, and, once you've run `sst dev`, the `sst` AppSync Events API.

## Application Details

The Astro site is static. When a file is submitted, the page asks the `Presign` function, a Lambda with a function URL linked to the bucket, for a one-off presigned `PUT` URL, then uploads the file straight to S3 with it. SST passes the function's URL to the site at build time as `PUBLIC_PRESIGN_URL`.
