import { join } from "node:path";
import { Architecture, FunctionUrlAuthType, LoggingFormat, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib/core";
import type { Construct } from "constructs";

export class LambdaDPCBasic extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    // Define the Lambda function
    const scalableFunction = new NodejsFunction(this, "ScalableFunction", {
      functionName: "scalable-function",
      entry: join(import.meta.dirname, "../functions/scalable", "index.ts"),
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.minutes(1),
      loggingFormat: LoggingFormat.JSON,
    });

    // Create an alias for the Lambda function
    const scalableFunctionAlias = scalableFunction.addAlias("live");

    // Register scalable function target
    const scalableFunctionTarget = scalableFunctionAlias.addAutoScaling({
      minCapacity: 1,
      maxCapacity: 5,
    });

    // Use the PCU predefined metric to create a target tracking scaling policy
    scalableFunctionTarget.scaleOnUtilization({
      utilizationTarget: 0.7,
    });

    // Attach a Function URL to the Lambda function alias
    const scalableFunctionAliasUrl = scalableFunctionAlias.addFunctionUrl({
      authType: FunctionUrlAuthType.NONE,
    });

    // Output the Function URL
    new CfnOutput(this, "ScalableFunctionAliasUrl", {
      value: scalableFunctionAliasUrl.url,
    });
  }
}
