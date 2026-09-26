import { join } from "node:path";
import { Architecture, LoggingFormat, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Duration, Stack, type StackProps } from "aws-cdk-lib/core";
import type { Construct } from "constructs";
import { validateEnv } from "../utils/validate-env.js";

const env = validateEnv(["HONEYCOMB_API_KEY"]);

export class MyStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    new NodejsFunction(this, "OtelHelloLambda", {
      functionName: "otel-hello-lambda",
      entry: join(import.meta.dirname, "../functions/hello", "index.ts"),
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(1),
      memorySize: 1024,
      loggingFormat: LoggingFormat.JSON,
      environment: {
        HONEYCOMB_API_KEY: env.HONEYCOMB_API_KEY,
        // OTel SDK - General
        OTEL_SERVICE_NAME: "otel-hello-lambda",
      },
    });
  }
}
