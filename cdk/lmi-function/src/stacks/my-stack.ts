import { join } from "node:path";
import {
  InstanceClass,
  InstanceSize,
  InstanceType,
  SecurityGroup,
  SubnetType,
  Vpc,
} from "aws-cdk-lib/aws-ec2";
import {
  Architecture,
  CapacityProvider,
  InstanceTypeFilter,
  LoggingFormat,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Duration, Stack, type StackProps } from "aws-cdk-lib/core";
import type { Construct } from "constructs";

export class MyStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    const defaultVpc = Vpc.fromLookup(this, "DefaultVpc", { isDefault: true });

    const defaultSg = new SecurityGroup(this, "DefaultSg", {
      vpc: defaultVpc,
    });

    const lmiCapacityProvider = new CapacityProvider(this, "LMICapacityProvider", {
      capacityProviderName: "lmi-capacity-provider",
      subnets: defaultVpc.selectSubnets({ subnetType: SubnetType.PUBLIC }).subnets,
      securityGroups: [defaultSg],
      architectures: [Architecture.ARM_64],
      instanceTypeFilter: InstanceTypeFilter.allow([
        InstanceType.of(InstanceClass.C8G, InstanceSize.XLARGE),
      ]),
      maxVCpuCount: 64,
    });

    const lmiFunction = new NodejsFunction(this, "LMIFunction", {
      functionName: "lmi-function",
      entry: join(import.meta.dirname, "../functions/hello/index.ts"),
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 2048,
      timeout: Duration.minutes(1),
      loggingFormat: LoggingFormat.JSON,
    });

    lmiCapacityProvider.addFunction(lmiFunction, {
      executionEnvironmentMemoryGiBPerVCpu: 2,
      perExecutionEnvironmentMaxConcurrency: 1,
      latestPublishedScalingConfig: {
        minExecutionEnvironments: 1,
        maxExecutionEnvironments: 4,
      },
    });
  }
}
