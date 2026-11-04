import {
  InstanceClass,
  InstanceSize,
  InstanceType,
  SecurityGroup,
  SubnetType,
  Vpc,
} from "aws-cdk-lib/aws-ec2";
import type { IRepository } from "aws-cdk-lib/aws-ecr";
import {
  AwsLogDriver,
  Cluster,
  ContainerImage,
  CpuArchitecture,
  FargateTaskDefinition,
  OperatingSystemFamily,
} from "aws-cdk-lib/aws-ecs";
import {
  Architecture,
  CapacityProvider,
  Code,
  Handler,
  InstanceTypeFilter,
  Function as LambdaFunction,
  LoggingFormat,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib/core";
import type { Construct } from "constructs";
import { RESOURCE_PREFIX, VARIANTS } from "../constants.js";

interface ComputeStackProps extends StackProps {
  readonly repository: IRepository;
}

export class ComputeStack extends Stack {
  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

    const defaultVpc = Vpc.fromLookup(this, "DefaultVpc", { isDefault: true });
    const publicSubnets = defaultVpc.selectSubnets({ subnetType: SubnetType.PUBLIC }).subnets;

    const securityGroup = new SecurityGroup(this, "SecurityGroup", { vpc: defaultVpc });

    new Cluster(this, "Cluster", {
      clusterName: RESOURCE_PREFIX,
      vpc: defaultVpc,
    });

    for (const { name, tag, loadAt } of VARIANTS) {
      // A capacity provider each, so a variant can't reuse image layers another one pulled.
      const capacityProvider = new CapacityProvider(this, `CapacityProvider-${name}`, {
        capacityProviderName: `${RESOURCE_PREFIX}-${name}`,
        subnets: publicSubnets,
        securityGroups: [securityGroup],
        architectures: [Architecture.ARM_64],
        instanceTypeFilter: InstanceTypeFilter.allow([
          InstanceType.of(InstanceClass.C7G, InstanceSize.XLARGE),
        ]),
        maxVCpuCount: 16,
        // Lambda would otherwise create this log group outside the stack
        logGroup: new LogGroup(this, `SystemLogGroup-${name}`, {
          logGroupName: `/aws/lambda/capacity-provider/${RESOURCE_PREFIX}-${name}`,
        }),
      });

      const lmiFunction = new LambdaFunction(this, `Function-${name}`, {
        functionName: `${RESOURCE_PREFIX}-${name}`,
        code: Code.fromEcrImage(props.repository, { tagOrDigest: tag }),
        handler: Handler.FROM_IMAGE,
        runtime: Runtime.FROM_IMAGE,
        architecture: Architecture.ARM_64,
        memorySize: 4096,
        timeout: Duration.minutes(5),
        loggingFormat: LoggingFormat.JSON,
        environment: { LOAD_AT: loadAt },
      });

      capacityProvider.addFunction(lmiFunction, {
        executionEnvironmentMemoryGiBPerVCpu: 2,
        perExecutionEnvironmentMaxConcurrency: 1,
        // Lambda still starts three environments on the first publish, then applies this, so
        // instances only run during the deployment and while `pnpm measure` needs them.
        latestPublishedScalingConfig: {
          minExecutionEnvironments: 0,
          maxExecutionEnvironments: 0,
        },
      });

      // A one-shot task has no later request to defer the load to
      if (loadAt === "handler") continue;

      // Same vCPU and memory as the function above
      const taskDefinition = new FargateTaskDefinition(this, `TaskDefinition-${name}`, {
        family: `${RESOURCE_PREFIX}-${name}`,
        cpu: 2048,
        memoryLimitMiB: 4096,
        runtimePlatform: {
          cpuArchitecture: CpuArchitecture.ARM64,
          operatingSystemFamily: OperatingSystemFamily.LINUX,
        },
      });

      taskDefinition.addContainer("Workload", {
        image: ContainerImage.fromEcrRepository(props.repository, tag),
        entryPoint: ["python", "/var/task/task.py"],
        environment: { LOAD_AT: loadAt },
        logging: new AwsLogDriver({ streamPrefix: name }),
      });
    }

    new CfnOutput(this, "SecurityGroupId", { value: securityGroup.securityGroupId });
    new CfnOutput(this, "SubnetIds", {
      value: publicSubnets.map((subnet) => subnet.subnetId).join(","),
    });
  }
}
