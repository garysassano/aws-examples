import { CfnExpressGatewayService } from "aws-cdk-lib/aws-ecs";
import { ManagedPolicy, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib/core";
import type { Construct } from "constructs";
import { type DockerHubCacheStack, NGINX_IMAGE_TAG } from "./docker-hub-cache-stack.js";

export interface EcsExpressStackProps extends StackProps {
  readonly cache: DockerHubCacheStack;
}

/**
 * ECS Express Mode service, the successor to App Runner. From one resource, ECS
 * provisions the Fargate service, an HTTPS Application Load Balancer, security groups
 * and auto scaling in the default VPC.
 * @see https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-work.html
 */
export class EcsExpressStack extends Stack {
  constructor(scope: Construct, id: string, props: EcsExpressStackProps) {
    super(scope, id, props);

    //==============================================================================
    // IAM
    //==============================================================================

    // Role that ECS uses to pull the image and write logs
    const executionRole = new Role(this, "ExecutionRole", {
      assumedBy: new ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonECSTaskExecutionRolePolicy"),
      ],
    });
    props.cache.grantPullThroughCache(executionRole);

    // Role that ECS uses to manage the load balancer, security groups and auto scaling
    const infrastructureRole = new Role(this, "InfrastructureRole", {
      assumedBy: new ServicePrincipal("ecs.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonECSInfrastructureRoleforExpressGatewayServices",
        ),
      ],
    });

    //==============================================================================
    // ECS
    //==============================================================================

    const nginxService = new CfnExpressGatewayService(this, "NginxService", {
      executionRoleArn: executionRole.roleArn,
      infrastructureRoleArn: infrastructureRole.roleArn,
      primaryContainer: {
        image: props.cache.nginxRepository.repositoryUriForTag(NGINX_IMAGE_TAG),
        containerPort: 80,
      },
      cpu: "256",
      memory: "512",
      healthCheckPath: "/",
      scalingTarget: { minTaskCount: 1, maxTaskCount: 2 },
    });

    // The roles' policies are separate resources, so without these dependencies ECS can
    // try to use the roles before they carry the required permissions.
    nginxService.node.addDependency(executionRole, infrastructureRole);

    new CfnOutput(this, "NginxUrl", {
      value: `https://${nginxService.attrEndpoint}`,
    });
  }
}
