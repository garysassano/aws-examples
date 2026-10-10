import { join } from "node:path";
import { PythonFunction } from "@aws-cdk/aws-lambda-python-alpha";
import {
  Alias,
  ApplicationLogLevel,
  Architecture,
  LoggingFormat,
  Runtime,
  RuntimeFamily,
  SnapStartConf,
  SystemLogLevel,
} from "aws-cdk-lib/aws-lambda";
import {
  Annotations,
  CfnOutput,
  DockerImage,
  Duration,
  Stack,
  type StackProps,
} from "aws-cdk-lib/core";
import type { Construct } from "constructs";
import { UvPythonFunction } from "../constructs/uv-python-function.js";

// Public preview runtime; aws-cdk-lib has no Runtime.PYTHON_3_15 constant yet. Preview runtimes
// support every feature the GA ones do, SnapStart included.
const PYTHON_3_15 = new Runtime("python3.15", RuntimeFamily.PYTHON, { supportsSnapStart: true });

// Both functions deploy the same uv project with the same settings; only the construct differs.
const entry = join(import.meta.dirname, "../functions/app");
const uvVersion = "0.13.0";
const shared = {
  runtime: PYTHON_3_15,
  architecture: Architecture.ARM_64,
  memorySize: 512,
  timeout: Duration.seconds(10),
  // SnapStart applies to published versions only, so each function is invoked through an alias.
  snapStart: SnapStartConf.ON_PUBLISHED_VERSIONS,
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

    for (const [name, fn] of Object.entries({ Enhanced: enhanced, Alpha: alpha })) {
      new Alias(this, `${name}Live`, { aliasName: "live", version: fn.currentVersion });
      Annotations.of(fn).acknowledgeWarning(
        "@aws-cdk/aws-lambda:snapStartRequirePublish",
        "The live alias points at a published version",
      );
      new CfnOutput(this, `${name}FunctionName`, { value: fn.functionName });
    }
  }
}
