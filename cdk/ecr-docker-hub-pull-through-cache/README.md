# cdk-ecr-docker-hub-pull-through-cache

CDK app that caches the NGINX image from Docker Hub in Amazon ECR with a [pull-through cache rule](https://docs.aws.amazon.com/AmazonECR/latest/userguide/pull-through-cache.html), then runs it on [Amazon ECS Express Mode](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-work.html), Amazon ECS on Fargate behind an Application Load Balancer, or [AWS App Runner](https://docs.aws.amazon.com/apprunner/latest/dg/what-is-apprunner.html).

Docker Hub is contacted only on the first pull of a tag and when ECR revalidates it, at most once every 24 hours. Every other pull is served from ECR in the same Region.

> [!IMPORTANT]
> App Runner is [closed to new customers](https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html), so `-c service=apprunner` deploys only in accounts that already use it. AWS recommends ECS Express Mode as its replacement.

## Prerequisites

- **_AWS:_**
  - Must have authenticated with [Default Credentials](https://docs.aws.amazon.com/cdk/v2/guide/cli.html#cli_auth) in your local environment.
  - Must have completed the [CDK bootstrapping](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html) for the target AWS environment.
  - The target Region must have a default VPC with public subnets in at least two Availability Zones, which both ECS services use.
- **_Docker Hub:_**
  - Must have stored your Docker Hub username and [access token](https://docs.docker.com/security/access-tokens/) in AWS Secrets Manager as a secret named `ecr-pullthroughcache/docker-hub`, in the Region you deploy to, so the token never appears in the CloudFormation template. A token with read-only access to public repositories is enough.

    ```sh
    aws secretsmanager create-secret --name ecr-pullthroughcache/docker-hub \
      --secret-string "{\"username\":\"$DOCKERHUB_USERNAME\",\"accessToken\":\"$DOCKERHUB_ACCESS_TOKEN\"}"
    ```

- **_mise:_**
  - [Install mise](https://mise.jdx.dev/installing-mise.html), which manages the required toolchain.

## Installation

```sh
mise install
pnpm install
```

## Deployment

```sh
pnpm run deploy --all
```

This deploys the pull-through cache and ECS Express Mode. To run NGINX on another service, or on all three side by side, pass `-c service=ecs-fargate`, `-c service=apprunner`, or `-c service=all`:

```sh
pnpm run deploy --all -c service=ecs-fargate
```

Each service prints the URL of its NGINX service as an output.

## Cleanup

```sh
pnpm destroy --all
```

The app creates only the stacks for the chosen service, so pass the same value to remove another service:

```sh
pnpm destroy --all -c service=ecs-fargate
```

The Docker Hub secret is not managed by the app, so delete it separately:

```sh
aws secretsmanager delete-secret --secret-id ecr-pullthroughcache/docker-hub --force-delete-without-recovery
```

ECS Express Mode creates the `default` ECS cluster if it does not already exist, and it is kept after the stack is deleted.

## Architecture Diagram - High Level

![Architecture Diagram - High Level](./src/assets/arch-hld.svg)

## Architecture Diagram - Low Level

![Architecture Diagram - Low Level](./src/assets/arch-lld.svg)

1. **Pulling the tag**
   - A service pulls `stable-alpine` from `<account>.dkr.ecr.<region>.amazonaws.com/docker-hub/library/nginx`. The `docker-hub` prefix matches the pull-through cache rule, which maps the rest of the path to `registry-1.docker.io/library/nginx`. Besides the usual pull actions, the service's role needs `ecr:BatchImportUpstreamImage`, which lets the pull fill the cache.

2. **Reading the Docker Hub token**
   - On a cache miss, which is the first pull of the tag or a pull more than 24 hours after ECR last checked it against Docker Hub, ECR's service-linked role `AWSServiceRoleForECRPullThroughCache` reads the token from the `ecr-pullthroughcache/docker-hub` secret.

3. **Pulling from Docker Hub**
   - ECR pulls `library/nginx:stable-alpine` from Docker Hub with that token: the image index and every manifest it references, which are 8 platform images and 8 attestation manifests. If Docker Hub cannot be reached, ECR serves the copy it already has.

4. **Caching the image**
   - ECR stores the index and its manifests in `docker-hub/library/nginx`. Only the index carries the tag; the manifests stay untagged and are kept for as long as an index references them.

5. **Reading the platform manifest**
   - Each service reads the manifest for its own platform from the index: App Runner and ECS Express Mode run `linux/amd64`, and ECS on Fargate runs `linux/arm64`. The other platforms' manifests stay cached but unused.

### Design Notes

- **One cache for every service.** A pull-through cache rule exists once per registry, so the rule and the cache repository live in a shared stack that each service stack depends on, and deploying a service deploys it first.
- **Grants instead of a registry policy.** Each service role gets `ecr:BatchImportUpstreamImage` on the cache repository directly. ECR also accepts the permission through the registry permissions policy, but that is a single document per registry, and writing it from this app would replace any policy already there.
- **A repository created in advance.** ECR creates a cache repository on the first pull by itself. Creating it in the stack instead lets the services reference it, gives it a lifecycle rule that expires superseded images after 7 days, and lets `cdk destroy` remove it with its images. Its tags stay mutable, since ECR overwrites `stable-alpine` when the upstream image changes.
- **A secret created by hand.** Creating the secret in the stack would put the token in the CloudFormation template, where anyone who can read the stack can see it. The stack references the existing secret by name instead.
