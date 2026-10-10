# cdk-lambda-python-uv

CDK app that deploys a Python Lambda function from a [uv](https://docs.astral.sh/uv/) workspace, through a `UvPythonFunction` construct that follows uv's [AWS Lambda guide](https://docs.astral.sh/uv/guides/integration/aws-lambda/) and adds what the guide leaves out.

The function returns a report of how its package was loaded: the interpreter, the CPU, where each module came from, and whether Python could use its shipped bytecode.

## What the construct does

- **Builds on the host, without Docker.** `uv pip install --python-platform aarch64-manylinux_2_34` installs wheels for Lambda's CPU and Amazon Linux 2023's glibc, whatever the host runs. When uv is missing, the same commands run in the `ghcr.io/astral-sh/uv` image.
- **Splits dependencies from code.** Third-party packages (`uv export --no-emit-local`) go into a layer whose asset hash comes from `uv.lock` and the target alone, so a code change uploads only the project's own few kilobytes and leaves the layer version as it is. The project and its workspace members (`--only-emit-local`) go into the function's code.
- **Ships bytecode Lambda can use.** The CDK CLI zips assets with every file's mtime reset to the same fixed date, so timestamp-based `.pyc` files never match their source on Lambda. They are ignored, and the read-only code directories mean Python compiles every module again on each cold start. The construct compiles with `PYC_INVALIDATION_MODE=UNCHECKED_HASH`, which Python trusts without checking the source.
- **Installs only what the lockfile pins.** `uv export --locked` fails when `uv.lock` no longer matches `pyproject.toml`, dependencies install as wheels only (`--no-build`) and with `--require-hashes`, and `--no-installer-metadata` leaves out the files that would differ between builds.

The Python project sets `exclude-newer = "3 days"`, uv's [dependency cooldown](https://docs.astral.sh/uv/concepts/resolution/#dependency-cooldowns), to match the workspace's pnpm `minimumReleaseAge`.

### Cold starts

Init duration of this function, 512 MB on arm64, over 10 forced cold starts each:

| Bytecode | Report on Lambda | Mean init |
| --- | --- | --- |
| Hash-based `.pyc` (this construct) | `unchecked-hash` | 228 ms |
| None | `missing` | 516 ms |
| Timestamp-based `.pyc` | `timestamp, stale` | 566 ms |

## Prerequisites

- **_AWS:_**
  - Must have authenticated with [Default Credentials](https://docs.aws.amazon.com/cdk/v2/guide/cli.html#cli-auth) in your local environment.
  - Must have completed the [CDK bootstrapping](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html) for the target AWS environment.
- **_mise:_**
  - [Install mise](https://mise.jdx.dev/installing-mise.html), which manages the required toolchain, including uv.

## Installation

```sh
mise install
pnpm install
```

## Deployment

```sh
pnpm run deploy
```

Then invoke the function:

```sh
aws lambda invoke --function-name lambda-python-uv \
  --cli-binary-format raw-in-base64-out --payload '{"name": "uv"}' response.json
```

## Cleanup

```sh
pnpm destroy
```
