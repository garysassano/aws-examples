import { Cpu, HealthCheck, Memory, Service, Source } from "@aws-cdk/aws-apprunner-alpha";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib/core";
import type { Construct } from "constructs";
import { type DockerHubCacheStack, NGINX_IMAGE_TAG } from "./dockerhub-cache-stack.js";

export interface AppRunnerStackProps extends StackProps {
  readonly cache: DockerHubCacheStack;
}

/**
 * App Runner is closed to new customers, so only accounts that already use it can deploy
 * this stack.
 * @see https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html
 */
export class AppRunnerStack extends Stack {
  constructor(scope: Construct, id: string, props: AppRunnerStackProps) {
    super(scope, id, props);

    //==============================================================================
    // IAM
    //==============================================================================

    // Role that App Runner uses to pull the image from ECR
    const accessRole = new Role(this, "AccessRole", {
      assumedBy: new ServicePrincipal("build.apprunner.amazonaws.com"),
    });
    props.cache.grantPullThroughCache(accessRole);

    //==============================================================================
    // APP RUNNER
    //==============================================================================

    const nginxService = new Service(this, "NginxService", {
      accessRole,
      source: Source.fromEcr({
        repository: props.cache.nginxRepository,
        tagOrDigest: NGINX_IMAGE_TAG,
        imageConfiguration: { port: 80 },
      }),
      cpu: Cpu.QUARTER_VCPU,
      memory: Memory.HALF_GB,
      healthCheck: HealthCheck.http({ path: "/" }),
    });

    // The access role's policy is a separate resource, so without this dependency App
    // Runner can try to pull the image before it is allowed to.
    nginxService.node.addDependency(accessRole);

    new CfnOutput(this, "NginxUrl", {
      value: `https://${nginxService.serviceUrl}`,
    });
  }
}
