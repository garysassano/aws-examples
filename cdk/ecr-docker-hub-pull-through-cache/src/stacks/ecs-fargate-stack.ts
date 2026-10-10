import { SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import {
  ContainerImage,
  CpuArchitecture,
  LogDrivers,
  OperatingSystemFamily,
} from "aws-cdk-lib/aws-ecs";
import { ApplicationLoadBalancedFargateService } from "aws-cdk-lib/aws-ecs-patterns";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib/core";
import type { Construct } from "constructs";
import { type DockerHubCacheStack, NGINX_IMAGE_TAG } from "./docker-hub-cache-stack.js";

export interface EcsFargateStackProps extends StackProps {
  readonly cache: DockerHubCacheStack;
}

/**
 * ECS service on Fargate behind an Application Load Balancer that this stack manages,
 * for full control over networking, deployments and scaling.
 */
export class EcsFargateStack extends Stack {
  constructor(scope: Construct, id: string, props: EcsFargateStackProps) {
    super(scope, id, props);

    //==============================================================================
    // VPC
    //==============================================================================

    const defaultVpc = Vpc.fromLookup(this, "DefaultVpc", { isDefault: true });

    //==============================================================================
    // CLOUDWATCH LOGS
    //==============================================================================

    const nginxLogGroup = new LogGroup(this, "NginxLogGroup", {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    //==============================================================================
    // ECS
    //==============================================================================

    // The default VPC has only public subnets, so tasks get public IPs to reach ECR
    // instead of going through a NAT gateway or VPC endpoints.
    const nginxService = new ApplicationLoadBalancedFargateService(this, "NginxService", {
      vpc: defaultVpc,
      taskSubnets: { subnetType: SubnetType.PUBLIC },
      assignPublicIp: true,
      publicLoadBalancer: true,
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        cpuArchitecture: CpuArchitecture.ARM64,
        operatingSystemFamily: OperatingSystemFamily.LINUX,
      },
      taskImageOptions: {
        image: ContainerImage.fromEcrRepository(props.cache.nginxRepository, NGINX_IMAGE_TAG),
        containerName: "nginx",
        containerPort: 80,
        logDriver: LogDrivers.awsLogs({
          logGroup: nginxLogGroup,
          streamPrefix: "nginx",
        }),
      },
      desiredCount: 2,
      minHealthyPercent: 100,
      circuitBreaker: { rollback: true },
      healthCheckGracePeriod: Duration.seconds(30),
    });

    const executionRole = nginxService.taskDefinition.obtainExecutionRole();
    props.cache.grantPullThroughCache(executionRole);

    // The execution role's policy is a separate resource, so without this dependency
    // tasks can try to pull the image before they are allowed to.
    nginxService.service.node.addDependency(executionRole);

    //==============================================================================
    // ALB
    //==============================================================================

    nginxService.targetGroup.configureHealthCheck({
      path: "/",
      healthyHttpCodes: "200",
      interval: Duration.seconds(10),
      healthyThresholdCount: 2,
    });

    // nginx has no long-lived requests to drain, so the 300-second default only slows
    // down deployments.
    nginxService.targetGroup.setAttribute("deregistration_delay.timeout_seconds", "30");
  }
}
