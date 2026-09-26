import { join } from "node:path";
import { ScalableTarget, ServiceNamespace } from "aws-cdk-lib/aws-applicationautoscaling";
import { Metric, Stats, Unit } from "aws-cdk-lib/aws-cloudwatch";
import {
  Alias,
  Architecture,
  FunctionUrlAuthType,
  LoggingFormat,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib/core";
import type { Construct } from "constructs";

export class LambdaDPCAdvanced extends Stack {
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
    const scalableFunctionAlias = new Alias(this, "ScalableFunctionAlias", {
      aliasName: "live",
      version: scalableFunction.currentVersion,
    });

    // Register Lambda function PC as scalable target
    const scalableTarget = new ScalableTarget(this, "ScalableTarget", {
      serviceNamespace: ServiceNamespace.LAMBDA,
      resourceId: `function:${scalableFunction.functionName}:${scalableFunctionAlias.aliasName}`,
      scalableDimension: "lambda:function:ProvisionedConcurrency",
      minCapacity: 1,
      maxCapacity: 5,
    });
    // Ensure the function alias is created before the scalable target
    scalableTarget.node.addDependency(scalableFunctionAlias);

    // Define a PCU custom metric
    const customMetric = new Metric({
      namespace: "AWS/Lambda",
      metricName: "ProvisionedConcurrencyUtilization",
      statistic: Stats.MAXIMUM,
      dimensionsMap: {
        FunctionName: scalableFunction.functionName,
        Resource: `${scalableFunction.functionName}:${scalableFunctionAlias.aliasName}`,
      },
      unit: Unit.COUNT,
      period: Duration.minutes(1),
    });

    // Use the PCU predefined metric to create a target tracking scaling policy
    // scalableTarget.scaleToTrackMetric("ProvisionedConcurrencyUtilization", {
    //   predefinedMetric:
    //     PredefinedMetric.LAMBDA_PROVISIONED_CONCURRENCY_UTILIZATION,
    //   targetValue: 0.7,
    // });

    // Use the PCU custom metric to create a target tracking scaling policy
    scalableTarget.scaleToTrackMetric("ProvisionedConcurrencyUtilization", {
      customMetric,
      targetValue: 0.7,
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
