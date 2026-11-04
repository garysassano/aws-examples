# cdk-soci-lazy-loading

CDK app that measures [Seekable OCI (SOCI)](https://github.com/awslabs/soci-snapshotter) lazy loading on two compute services, [Lambda Managed Instances](https://docs.aws.amazon.com/lambda/latest/dg/lambda-managed-instances-seekable-oci.html) and [Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-tasks-services.html). On Lambda, SOCI is only available on Managed Instances.

SOCI starts a container before its image has been downloaded and fetches files as they are read. The app pushes one 3.7 GiB image to Amazon ECR under two tags, with and without a SOCI index, runs it on both services, and reports where the time goes. Both tags hold the same layers, so the index is the only difference.

### Related Apps

- [cdk/lambda-managed-instances](../lambda-managed-instances) - Runs a minimal function on Lambda Managed Instances from a zip archive.

## Prerequisites

- **_AWS:_**
  - Must have authenticated with [Default Credentials](https://docs.aws.amazon.com/cdk/v2/guide/cli.html#cli-auth) in your local environment. Synthesizing also needs them, because the app looks up the default VPC.
  - Must have completed the [CDK bootstrapping](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html) for the target AWS environment.
  - The account needs a default VPC in `eu-central-1`, where the app is pinned, and enough EC2 quota for 12 `c7g.xlarge` instances (48 vCPUs).
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

This takes about 10 minutes. It deploys the image stack, builds and indexes the image in CodeBuild, then deploys the compute stack, which needs both tags to exist.

The functions are deployed deactivated, but Lambda still starts three execution environments per function on the first publish, so about nine instances run for a few minutes during the deployment. They terminate on their own afterwards.

## Usage

Run the benchmark, which takes about 14 minutes for the default of three runs:

```sh
pnpm measure
```

Each row is a cold start with an empty image cache. See [Comparison](#comparison) for results and what each column means. The script deactivates the functions again when it finishes, so no instances stay up.

To confirm that the `soci` tag holds a SOCI index, while the stacks are deployed:

```sh
aws ecr batch-get-image --region eu-central-1 \
  --repository-name soci-lazy-loading --image-ids imageTag=soci \
  --query 'images[0].imageManifest' --output text |
  jq '.manifests[].artifactType'
```

## Cleanup

```sh
pnpm destroy
```

This deletes both stacks, including the ECR repository with its images and every log group. Only the image source and templates that CDK uploaded to its bootstrap bucket remain.

## Architecture Diagram

![Architecture Diagram](./src/assets/arch-diagram.svg)

## Application Details

### Variants

Every variant runs the same image with 2 vCPUs and 4 GiB of memory on `arm64`. The workload imports PyTorch and reads a 256 MiB weights file. A further 3 GiB file in the image is never read, standing in for the content a large image carries that a given run doesn't need.

| Variant        | Tag     | Loads the workload    | Runs on      |
| -------------- | ------- | --------------------- | ------------ |
| `plain-init`   | `plain` | During initialization | LMI, Fargate |
| `soci-init`    | `soci`  | During initialization | LMI, Fargate |
| `soci-handler` | `soci`  | In the first request  | LMI          |

A Fargate task runs the workload once and exits, so it has no later request to defer the load to.

### Building the index

`src/stacks/image-stack.ts` holds the build steps. The index is built with `nerdctl image convert --soci`, which produces the SOCI Index Manifest v2 that both services require, and the result is an image index with exactly two entries: the image and its SOCI index. Three details matter:

- The image is built with `--provenance=false`, because Lambda rejects the attestation manifests Docker adds by default.
- The index is built from containerd's image store, not Docker's, so the image is pushed and then pulled again with `nerdctl`.
- The pull uses `--unpack=false`, because indexing only needs the compressed layers and overlayfs can't unpack them on a CodeBuild container's disk.

### Enabling SOCI

Neither service has a setting for it. A function or task definition uses SOCI when its image URI points at the indexed tag. A function binds to the image when it's created, so rerunning `pnpm build-image` doesn't change deployed functions.

Fargate reports which snapshotter it used in the task metadata, and `pnpm measure` fails if that isn't the expected one. Lambda has no equivalent signal, so on Managed Instances the evidence for lazy loading is that an environment using a 3.7 GiB image is created in 10 seconds.

### Measuring

- **Fargate:** each run starts a new task. Timings come from the task's `pullStartedAt`, `pullStoppedAt`, and `createdAt` fields, plus the time the workload reports.
- **Lambda Managed Instances:** each run deactivates the function, waits for its instances to terminate, and activates it again. Timings come from the capacity provider's system logs, so they're Lambda's own timestamps. Each variant has its own capacity provider, so none can reuse layers another one pulled.

Managed instances are hidden from the default EC2 listing, so the script finds them with `IncludeManagedResources`.

## Comparison

Measured in a test AWS account in `eu-central-1` in November 2026. Values are the median of three runs in seconds, with the range in parentheses.

**Fargate:**

| Variant      | `pull`           | `load`         | `ready`            |
| ------------ | ---------------- | -------------- | ------------------ |
| `plain-init` | 90.6 (59.6-98.7) | 2.9 (1.2-3.0)  | 106.9 (93.2-114.1) |
| `soci-init`  | 2.3 (2.2-2.4)    | 9.9 (9.0-11.6) | 24.1 (23.4-39.2)   |

**Lambda Managed Instances:**

| Variant        | `environment`    | `active`            | `load`           | `firstRequest`   |
| -------------- | ---------------- | ------------------- | ---------------- | ---------------- |
| `plain-init`   | 67.2 (67.0-67.8) | 120.0 (120.0-120.0) | 1.9 (1.9-1.9)    | 0.0              |
| `soci-init`    | 31.1 (28.9-32.0) | 80.0 (80.0-81.0)    | 20.3 (19.0-20.9) | 0.0              |
| `soci-handler` | 10.3 (10.2-10.4) | 60.5 (60.0-60.5)    | 21.1 (19.8-21.8) | 21.1 (19.8-21.8) |

- `pull`: Fargate's image pull.
- `load`: importing the libraries and reading the weights.
- `ready`: from the task being created to its load finishing.
- `environment`: creating one execution environment, which covers the image and initialization but not the instance launch.
- `active`: from activating the function to Lambda marking it active, including launching instances.
- `firstRequest`: the duration of the first request.

What the numbers show:

- **SOCI moves work instead of removing it.** Skipping the full pull saves a minute or more on either service, while the files the workload does read take longer to arrive: `load` grows from under 3 seconds to about 10 on Fargate and 20 on Lambda. The net gain comes from the 3 GiB the workload never reads, so an image that's read in full gains less.
- **The saving depends on what you count.** On Lambda, against [AWS's "up to 70%"](https://aws.amazon.com/about-aws/whats-new/2026/10/aws-lambda-seekable-oci-soci/), creating an environment is 54% faster with `soci-init` and 85% faster with `soci-handler`, while activating the function is 33% and 50% faster. About 50 seconds of `active` is launching instances and other work that SOCI doesn't touch. On Fargate, `ready` is 77% faster.
- **Loading in the handler only hides the cost.** `soci-handler` goes active 20 seconds sooner than `soci-init`, and its first request then takes 21 seconds, so the workload is ready at about the same moment. Loading during initialization keeps that delay away from callers.
- **A full pull on Fargate varies the most.** Across nine runs over three benchmarks, `plain-init` was ready in 80 to 114 seconds and `soci-init` in 23 to 39, while `environment` on Lambda stayed within 7 seconds.

These numbers don't cover scaling out onto an instance that already holds the image, or files first read long after startup. `load` on Lambda is about twice that on Fargate with the same vCPUs and memory, and the benchmark doesn't isolate why. One documented difference is that Fargate keeps downloading the image in the background, while Lambda only fetches what's read.
