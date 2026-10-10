import {
  CfnPullThroughCacheRule,
  type IRepository,
  Repository,
  TagStatus,
} from "aws-cdk-lib/aws-ecr";
import { Grant, type IGrantable } from "aws-cdk-lib/aws-iam";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib/core";
import type { Construct } from "constructs";

/**
 * Secrets Manager secret holding the Docker Hub `username` and `accessToken`. It is created
 * before deployment, so the token never appears in the template. ECR only accepts secrets
 * whose names start with `ecr-pullthroughcache/`.
 * @see https://docs.aws.amazon.com/AmazonECR/latest/userguide/pull-through-cache-creating-rule.html#cache-rule-prereq
 */
export const DOCKER_HUB_SECRET_NAME = "ecr-pullthroughcache/docker-hub";

/**
 * Namespace that cached Docker Hub images live under, matching the ECR console default.
 * `nginx` on Docker Hub is cached as `docker-hub/library/nginx`.
 */
const DOCKER_HUB_REPOSITORY_PREFIX = "docker-hub";

/** Tag of the `nginx` image that every service deploys. */
export const NGINX_IMAGE_TAG = "stable-alpine";

export class DockerHubCacheStack extends Stack {
  /** Cache repository for the official `nginx` image on Docker Hub. */
  public readonly nginxRepository: IRepository;

  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    //==============================================================================
    // SECRETS MANAGER
    //==============================================================================

    const dockerHubSecret = Secret.fromSecretNameV2(
      this,
      "DockerHubSecret",
      DOCKER_HUB_SECRET_NAME,
    );

    //==============================================================================
    // ECR
    //==============================================================================

    const dockerHubCacheRule = new CfnPullThroughCacheRule(this, "DockerHubCacheRule", {
      ecrRepositoryPrefix: DOCKER_HUB_REPOSITORY_PREFIX,
      upstreamRegistry: "docker-hub",
      upstreamRegistryUrl: "registry-1.docker.io",
      credentialArn: dockerHubSecret.secretArn,
    });

    // Pre-creating the cache repository lets services reference it directly and lets
    // `cdk destroy` remove it with its cached images. Tags must stay mutable so that
    // ECR can refresh them when the upstream image changes.
    const nginxRepository = new Repository(this, "NginxRepository", {
      repositoryName: `${DOCKER_HUB_REPOSITORY_PREFIX}/library/nginx`,
      lifecycleRules: [
        {
          description: "Expire images superseded by an upstream refresh",
          tagStatus: TagStatus.UNTAGGED,
          maxImageAge: Duration.days(7),
        },
      ],
      removalPolicy: RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });
    nginxRepository.node.addDependency(dockerHubCacheRule);

    this.nginxRepository = nginxRepository;
  }

  /**
   * Grants permission to pull `nginx` through the cache.
   *
   * Besides the usual pull actions, the first pull of a tag, and each refresh after the
   * 24-hour validation window, needs `ecr:BatchImportUpstreamImage`. Granting it on the
   * principal avoids a registry permissions policy, which is a single document per
   * registry and would overwrite any existing one.
   * @see https://docs.aws.amazon.com/AmazonECR/latest/userguide/pull-through-cache-iam.html
   */
  public grantPullThroughCache(grantee: IGrantable): Grant {
    return this.nginxRepository.grantPull(grantee).combine(
      Grant.addToPrincipal({
        grantee,
        actions: ["ecr:BatchImportUpstreamImage"],
        resourceArns: [this.nginxRepository.repositoryArn],
      }),
    );
  }
}
