import { join } from "node:path";
import { ApplicationLogLevel, LoggingFormat, SystemLogLevel } from "aws-cdk-lib/aws-lambda";
import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib/core";
import type { Construct } from "constructs";
import { UvPythonFunction } from "../constructs/uv-python-function.js";

export class MyStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    const app = new UvPythonFunction(this, "App", {
      functionName: "lambda-python-uv",
      entry: join(import.meta.dirname, "../functions/app"),
      handler: "app.handler.handler",
      memorySize: 512,
      timeout: Duration.seconds(10),
      loggingFormat: LoggingFormat.JSON,
      applicationLogLevelV2: ApplicationLogLevel.INFO,
      systemLogLevelV2: SystemLogLevel.WARN,
      environment: {
        POWERTOOLS_SERVICE_NAME: "lambda-python-uv",
      },
    });

    new CfnOutput(this, "FunctionName", { value: app.functionName });
  }
}
