import { join } from "node:path";
import { LambdaIntegration, ResponseTransferMode, RestApi } from "aws-cdk-lib/aws-apigateway";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Architecture, LoggingFormat, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib/core";
import type { Construct } from "constructs";

export class MyStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    //==============================================================================
    // LAMBDA
    //==============================================================================

    const bedrockStreamingFunction = new NodejsFunction(this, "BedrockStreamingFunction", {
      functionName: "bedrock-streaming-function",
      entry: join(import.meta.dirname, "../functions/bedrock-streaming", "index.ts"),
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.minutes(5),
      loggingFormat: LoggingFormat.JSON,
      bundling: {
        bundleAwsSDK: true,
      },
    });

    bedrockStreamingFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          "bedrock:InvokeModelWithResponseStream",
          "bedrock-runtime:InvokeModelWithResponseStream",
        ],
        resources: ["*"],
      }),
    );

    //==============================================================================
    // APIGW
    //==============================================================================

    const bedrockStreamingApi = new RestApi(this, "BedrockStreamingApi", {
      restApiName: "bedrock-streaming-api",
      description: "API Gateway with response streaming for Bedrock",
    });

    // {api}/ask
    const askResource = bedrockStreamingApi.root.resourceForPath("/ask");
    askResource.addMethod(
      "POST",
      new LambdaIntegration(bedrockStreamingFunction, {
        responseTransferMode: ResponseTransferMode.STREAM,
      }),
    );

    //==============================================================================
    // OUTPUTS
    //==============================================================================

    new CfnOutput(this, "BedrockStreamingApiUrl", {
      value: `${bedrockStreamingApi.url}ask`,
      description: "API Gateway endpoint URL for Bedrock streaming",
    });
  }
}
