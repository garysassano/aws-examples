import { join } from "node:path";
import {
  type Alias,
  Architecture,
  FunctionUrlAuthType,
  LoggingFormat,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { CfnOutput, Duration } from "aws-cdk-lib/core";
import { Construct } from "constructs";

export interface ScalableFunctionProps {
  readonly functionName: string;
}

/**
 * The function both stacks scale, published behind a `live` alias with a public Function URL.
 */
export class ScalableFunction extends Construct {
  readonly function: NodejsFunction;
  readonly alias: Alias;

  constructor(scope: Construct, id: string, props: ScalableFunctionProps) {
    super(scope, id);

    this.function = new NodejsFunction(this, "Function", {
      functionName: props.functionName,
      entry: join(import.meta.dirname, "../functions/scalable", "index.ts"),
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.seconds(10),
      loggingFormat: LoggingFormat.JSON,
      environment: {
        POWERTOOLS_SERVICE_NAME: props.functionName,
      },
      bundling: {
        format: OutputFormat.ESM,
        mainFields: ["module", "main"],
        minify: true,
      },
    });

    // Provisioned concurrency needs a version or alias; `$LATEST` cannot have any
    this.alias = this.function.addAlias("live");

    // Invoke through the alias, otherwise requests never reach the provisioned environments
    const url = this.alias.addFunctionUrl({ authType: FunctionUrlAuthType.NONE });
    new CfnOutput(scope, `${id}Url`, { value: url.url });
  }
}
