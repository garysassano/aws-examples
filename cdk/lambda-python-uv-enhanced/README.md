# cdk-lambda-python-uv-enhanced

CDK app that deploys the same Python handler from the same [uv](https://docs.astral.sh/uv/) project twice: with `UvPythonFunction`, a construct in this example that follows uv's [AWS Lambda guide](https://docs.astral.sh/uv/guides/integration/aws-lambda/) and adds what the guide leaves out, and with the official [`PythonFunction`](https://github.com/aws/aws-cdk/tree/main/packages/%40aws-cdk/aws-lambda-python-alpha) from `@aws-cdk/aws-lambda-python-alpha`.

Both functions use the same runtime, architecture, memory, logging and uv version. Each returns a report of how its package was loaded: the interpreter, the CPU, where each module came from, and whether Python could use its shipped bytecode.

## Comparison

Measured in `eu-central-1` on `python3.14`, arm64, 512 MB, built on an x86_64 host:

| | `UvPythonFunction` | Official `PythonFunction` |
| --- | --- | --- |
| Median init, 15 forced cold starts | 260 ms | 490 ms |
| Bytecode on Lambda | `unchecked-hash`, used | `missing` |
| Deployment package | 6.6 KB code + 5.6 MB layer | 3.5 MB code |
| Upload after a handler-only change | 6.6 KB | 3.5 MB |
| Bundling | uv on the host, no Docker | Docker build of a 3.6 GB image |
| First synth, no Docker images cached | 222 s for both functions, almost all of it the official construct's image | |
| Synth with images cached | 5 s for both functions | |

Both install `aarch64` wheels, so `pydantic-core` loads on Lambda either way.

## What `UvPythonFunction` does

- **Builds on the host, without Docker.** `uv pip install --python-platform aarch64-manylinux_2_34` installs wheels for Lambda's CPU and Amazon Linux 2023's glibc, whatever the host runs. When uv is missing, the same commands run in the `ghcr.io/astral-sh/uv` image.
- **Splits dependencies from code.** Third-party packages (`uv export --no-emit-local`) go into a layer whose asset hash comes from `uv.lock` and the target alone, so a code change uploads only the project's own few kilobytes and leaves the layer version as it is. The project and any workspace members (`--only-emit-local`) are installed into the function's code.
- **Ships bytecode Lambda can use.** The CDK CLI zips assets with every file's mtime reset to the same fixed date, so timestamp-based `.pyc` files never match their source on Lambda. They are ignored, and the read-only code directories mean Python compiles every module again on each cold start. The construct compiles with `PYC_INVALIDATION_MODE=UNCHECKED_HASH`, which Python trusts without checking the source.
- **Installs only what the lockfile pins.** `uv export --locked` fails when `uv.lock` no longer matches `pyproject.toml`, dependencies install as wheels only (`--no-build`) and with `--require-hashes`, and `--no-installer-metadata` leaves out the files that would differ between builds.

The bytecode mode is what makes the difference in init time. With `UvPythonFunction` and nothing else changed, the mean init over 10 forced cold starts was 228 ms with hash-based `.pyc` files, 516 ms with none, and 566 ms with timestamp-based ones, which Lambda reports as stale.

The Python project sets `exclude-newer = "3 days"`, uv's [dependency cooldown](https://docs.astral.sh/uv/concepts/resolution/#dependency-cooldowns), to match the workspace's pnpm `minimumReleaseAge`. It keeps its package at the project root, because the official construct copies the project directory as-is rather than installing the project.

## Prerequisites

- **_AWS:_**
  - Must have authenticated with [Default Credentials](https://docs.aws.amazon.com/cdk/v2/guide/cli.html#cli-auth) in your local environment.
  - Must have completed the [CDK bootstrapping](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html) for the target AWS environment.
- **_mise:_**
  - [Install mise](https://mise.jdx.dev/installing-mise.html), which manages the required toolchain, including uv.
- **_Docker:_**
  - Must be [installed](https://docs.docker.com/get-docker/) in your system and running at deployment, for the official construct.

## Installation

```sh
mise install
pnpm install
```

## Deployment

```sh
pnpm run deploy
```

Then invoke either function:

```sh
aws lambda invoke --function-name lambda-python-uv-enhanced \
  --cli-binary-format raw-in-base64-out --payload '{"name": "uv"}' response.json
aws lambda invoke --function-name lambda-python-uv-alpha \
  --cli-binary-format raw-in-base64-out --payload '{"name": "uv"}' response.json
```

## Cleanup

```sh
pnpm destroy
```
