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

## Deployment

```sh
pnpm run deploy
```

## Usage

Access the website by clicking the `<CLOUDFRONT_DISTRIBUTION_URL>`:

```sh
✔  Complete
   MyWebsite: <CLOUDFRONT_DISTRIBUTION_URL>
```

## Cleanup

```sh
pnpm destroy
```

## How it works

The Astro site is static. When a file is submitted, the page asks the `Presign` function, a Lambda with a function URL linked to the bucket, for a one-off presigned `PUT` URL, then uploads the file straight to S3 with it. SST passes the function's URL to the site at build time as `PUBLIC_PRESIGN_URL`.
