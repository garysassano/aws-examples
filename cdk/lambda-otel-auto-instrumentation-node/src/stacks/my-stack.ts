import { join } from "node:path";
import { Architecture, LayerVersion, LoggingFormat, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Duration, Stack, type StackProps } from "aws-cdk-lib/core";
import type { Construct } from "constructs";
import { validateEnv } from "../utils/validate-env.js";

const env = validateEnv(["HONEYCOMB_API_KEY"]);

export class MyStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    const otelCollectorLayer = LayerVersion.fromLayerVersionArn(
      this,
      "OtelCollectorLayer",
      `arn:aws:lambda:${this.region}:184161586896:layer:opentelemetry-collector-arm64-0_19_0:1`,
    );
    const otelNodeLayer = LayerVersion.fromLayerVersionArn(
      this,
      "OtelNodeLayer",
      `arn:aws:lambda:${this.region}:184161586896:layer:opentelemetry-nodejs-0_19_0:1`,
    );

    new NodejsFunction(this, "OtelHelloLambda", {
      functionName: "otel-hello-lambda",
      entry: join(import.meta.dirname, "../functions/hello", "index.ts"),
      layers: [otelCollectorLayer, otelNodeLayer],
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.minutes(1),
      memorySize: 1024,
      loggingFormat: LoggingFormat.JSON,
      environment: {
        HONEYCOMB_API_KEY: env.HONEYCOMB_API_KEY,
        // OTel SDK - Lambda Extension
        AWS_LAMBDA_EXEC_WRAPPER: "/opt/otel-handler",
        OPENTELEMETRY_COLLECTOR_CONFIG_URI: "file:/var/task/collector-confmap.yml",
        OPENTELEMETRY_EXTENSION_LOG_LEVEL: "WARN",
      },
      bundling: {
        commandHooks: {
          beforeBundling() {
            return [];
          },
          // inputDir is the directory holding the lockfile, which is the
          // workspace root here, so resolve the config from this file instead.
          afterBundling(_inputDir: string, outputDir: string): string[] {
            return [
              `cp ${join(import.meta.dirname, "../otel/collector-confmap.yml")} ${outputDir}`,
            ];
          },
          beforeInstall() {
            return [];
          },
        },
      },
    });
  }
}
