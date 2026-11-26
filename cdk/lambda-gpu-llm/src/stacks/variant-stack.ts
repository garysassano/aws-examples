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
  Architecture,
  CapacityProvider,
  type CfnFunction,
  Code,
  Handler,
  InstanceTypeFilter,
  Function as LambdaFunction,
  LoggingFormat,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import type { IBucket } from "aws-cdk-lib/aws-s3";
import { Duration, Size, Stack, type StackProps, Validations } from "aws-cdk-lib/core";
import type { Construct } from "constructs";
import {
  BASE_TAG,
  MODEL_ID,
  MODEL_PATH,
  MODEL_PREFIX,
  MODEL_TAG,
  type Variant,
  functionName,
} from "../constants.js";

interface VariantStackProps extends StackProps {
  readonly variant: Variant;
  readonly repository: IRepository;
  readonly modelBucket: IBucket;
}

/** One function serving the model, with its weights from the source the variant names. */
export class VariantStack extends Stack {
  constructor(scope: Construct, id: string, props: VariantStackProps) {
    super(scope, id, props);

    const { variant, repository, modelBucket } = props;
    const name = functionName(variant);

    // The image tag and vLLM's settings for each source of the weights
    const sources: Record<Variant, { tag: string; environment: Record<string, string> }> = {
      hub: {
        tag: BASE_TAG,
        environment: { MODEL_ID },
      },
      s3: {
        tag: BASE_TAG,
        environment: {
          MODEL_ID: modelBucket.s3UrlForObject(MODEL_PREFIX),
          VLLM_LOAD_FORMAT: "runai_streamer",
          SERVED_MODEL_NAME: MODEL_ID,
        },
      },
      baked: {
        tag: MODEL_TAG,
        environment: { MODEL_ID: MODEL_PATH, SERVED_MODEL_NAME: MODEL_ID },
      },
    };
    const { tag, environment } = sources[variant];

    // Public subnets reach Hugging Face and S3 without a NAT gateway
    const defaultVpc = Vpc.fromLookup(this, "DefaultVpc", { isDefault: true });
    const securityGroup = new SecurityGroup(this, "SecurityGroup", { vpc: defaultVpc });

    // A capacity provider per variant, so none can reuse image layers another one pulled
    const capacityProvider = new CapacityProvider(this, "CapacityProvider", {
      capacityProviderName: name,
      subnets: defaultVpc.selectSubnets({ subnetType: SubnetType.PUBLIC }).subnets,
      securityGroups: [securityGroup],
      architectures: [Architecture.X86_64],
      // One NVIDIA L4 with 24 GB; a single type keeps the measurements comparable
      instanceTypeFilter: InstanceTypeFilter.allow([
        InstanceType.of(InstanceClass.G6, InstanceSize.XLARGE2),
      ]),
      // The lowest cap Lambda accepts, which still allows only one 8-vCPU instance
      maxVCpuCount: 12,
      // Lambda would otherwise create this log group outside the stack
      logGroup: new LogGroup(this, "SystemLogGroup", {
        logGroupName: `/aws/lambda/capacity-provider/${name}`,
      }),
    });

    const llmFunction = new LambdaFunction(this, "Function", {
      functionName: name,
      code: Code.fromEcrImage(repository, { tagOrDigest: tag }),
      handler: Handler.FROM_IMAGE,
      runtime: Runtime.FROM_IMAGE,
      architecture: Architecture.X86_64,
      memorySize: 16_384,
      // Also the initialization timeout, which includes loading the model
      timeout: Duration.minutes(15),
      loggingFormat: LoggingFormat.JSON,
      // Lambda starts execution environments when it publishes the function, so the log group
      // must exist before the function; CDK's default one is created after it, too late to log.
      logGroup: new LogGroup(this, "LogGroup", { logGroupName: `/aws/lambda/${name}` }),
      environment,
    });

    // aws-cdk-lib has neither GPU settings nor the GPU limits yet
    const cfnFunction = llmFunction.node.defaultChild as CfnFunction;
    // One GPU with at least this much memory per execution environment
    cfnFunction.addPropertyOverride("AcceleratorConfig", { AcceleratorMemorySize: 24 });
    // Room in /tmp for the Hugging Face download, over the 10 GiB other functions get
    cfnFunction.addPropertyOverride("EphemeralStorage.Size", Size.gibibytes(16).toMebibytes());
    Validations.of(cfnFunction).acknowledge({
      id: "CloudFormation-Validate::F3002",
      reason: "The bundled schemas predate AcceleratorConfig",
    });

    if (variant === "s3") modelBucket.grantRead(llmFunction);

    capacityProvider.addFunction(llmFunction, {
      // 16 GiB at 4 GiB per vCPU takes half of a g6.2xlarge's vCPUs
      executionEnvironmentMemoryGiBPerVCpu: 4,
      // No execution environment, and no GPU to pay for, while nothing calls the function
      latestPublishedScalingConfig: {
        minExecutionEnvironments: 0,
        maxExecutionEnvironments: 1,
      },
    });
  }
}
