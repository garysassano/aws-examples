import { join } from "node:path";
import { PythonFunction } from "@aws-cdk/aws-lambda-python-alpha";
import {
  ApplicationLogLevel,
  Architecture,
  LoggingFormat,
  Runtime,
  RuntimeFamily,
  SystemLogLevel,
} from "aws-cdk-lib/aws-lambda";
import { CfnOutput, DockerImage, Duration, Stack, type StackProps } from "aws-cdk-lib/core";
import type { Construct } from "constructs";
import { UvPythonFunction } from "../constructs/uv-python-function.js";

// Public preview runtime; aws-cdk-lib has no Runtime.PYTHON_3_15 constant yet.
const PYTHON_3_15 = new Runtime("python3.15", RuntimeFamily.PYTHON);

// Both functions deploy the same uv project with the same settings; only the construct differs.
const entry = join(import.meta.dirname, "../functions/app");
const uvVersion = "0.13.0";
const shared = {
  runtime: PYTHON_3_15,
  architecture: Architecture.ARM_64,
  memorySize: 512,
  timeout: Duration.seconds(10),
  loggingFormat: LoggingFormat.JSON,
  applicationLogLevelV2: ApplicationLogLevel.INFO,
  systemLogLevelV2: SystemLogLevel.WARN,
  environment: {
    POWERTOOLS_SERVICE_NAME: "lambda-python-uv",
  },
};

export class MyStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    const enhanced = new UvPythonFunction(this, "Enhanced", {
      ...shared,
      functionName: "lambda-python-uv-enhanced",
      entry,
      handler: "app.handler.handler",
      uvVersion,
    });

    // The official construct: it finds uv.lock, exports the third-party dependencies, and
    // installs them with uv in its Docker image next to a copy of the project directory.
    const alpha = new PythonFunction(this, "Alpha", {
      ...shared,
      functionName: "lambda-python-uv-alpha",
      entry,
      index: "app/handler.py",
      handler: "handler",
      bundling: {
        // There is no SAM build image for python3.15 yet, which the construct builds its own from.
        image: DockerImage.fromBuild(join(import.meta.dirname, "../docker/alpha-bundling"), {
          buildArgs: { UV_VERSION: uvVersion },
          platform: "linux/arm64",
        }),
        assetExcludes: [".venv", ".ruff_cache"],
      },
    });

    new CfnOutput(this, "EnhancedFunctionName", { value: enhanced.functionName });
    new CfnOutput(this, "AlphaFunctionName", { value: alpha.functionName });
  }
}
