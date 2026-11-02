import { join } from "node:path";
import {
  EndpointType,
  LambdaIntegration,
  ResponseTransferMode,
  RestApi,
} from "aws-cdk-lib/aws-apigateway";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Architecture, LoggingFormat, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { CfnOutput, Duration, Stack, type StackProps, Token } from "aws-cdk-lib/core";
import type { Construct } from "constructs";

// Nova Micro, the cheapest text model on Bedrock, which it serves only through the US and EU
// cross-Region inference profiles.
const FOUNDATION_MODEL_ID = "amazon.nova-micro-v1:0";
const GEOGRAPHIES = ["us", "eu"];

// API Gateway streams a response for up to 15 minutes, past the 29s integration timeout of a
// buffered response.
const STREAM_TIMEOUT = Duration.minutes(15);

export class MyStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    // The profile ID starts with the geography of the Region it is called from, such as `eu.`.
    const geography = Token.isUnresolved(this.region) ? undefined : this.region.split("-")[0];
    if (!geography || !GEOGRAPHIES.includes(geography)) {
      throw new Error(
        `Deploy to a US or EU Region to use ${FOUNDATION_MODEL_ID}, not ${this.region}`,
      );
    }
    const inferenceProfileId = `${geography}.${FOUNDATION_MODEL_ID}`;

    //==============================================================================
    // LAMBDA
    //==============================================================================

    const bedrockStreamingFunction = new NodejsFunction(this, "BedrockStreamingFunction", {
      functionName: "bedrock-streaming-function",
      entry: join(import.meta.dirname, "../functions/bedrock-streaming", "index.ts"),
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      timeout: STREAM_TIMEOUT,
      loggingFormat: LoggingFormat.JSON,
      environment: {
        MODEL_ID: inferenceProfileId,
      },
      bundling: {
        bundleAwsSDK: true,
      },
    });

    // ConverseStream needs bedrock:InvokeModelWithResponseStream on the inference profile and on the
    // model in each Region the profile routes to. The condition limits the model statement to
    // calls through this profile, so it needs no list of destination Regions.
    const inferenceProfileArn = this.formatArn({
      service: "bedrock",
      resource: "inference-profile",
      resourceName: inferenceProfileId,
    });
    bedrockStreamingFunction.addToRolePolicy(
      new PolicyStatement({
        actions: ["bedrock:InvokeModelWithResponseStream"],
        resources: [inferenceProfileArn],
      }),
    );
    bedrockStreamingFunction.addToRolePolicy(
      new PolicyStatement({
        actions: ["bedrock:InvokeModelWithResponseStream"],
        resources: [
          this.formatArn({
            service: "bedrock",
            region: "*",
            account: "",
            resource: "foundation-model",
            resourceName: FOUNDATION_MODEL_ID,
          }),
        ],
        conditions: {
          StringEquals: { "bedrock:InferenceProfileArn": inferenceProfileArn },
        },
      }),
    );

    //==============================================================================
    // APIGW
    //==============================================================================

    const bedrockStreamingApi = new RestApi(this, "BedrockStreamingApi", {
      restApiName: "bedrock-streaming-api",
      description: "REST API that streams Amazon Bedrock responses from Lambda",
      // An edge-optimized endpoint closes a stream after 30s without data; a Regional one after 5m.
      endpointTypes: [EndpointType.REGIONAL],
      deployOptions: {
        // The API is public and every request spends Bedrock tokens, so keep its rate low.
        throttlingRateLimit: 5,
        throttlingBurstLimit: 10,
      },
    });

    // {api}/ask
    const askResource = bedrockStreamingApi.root.addResource("ask");
    askResource.addMethod(
      "POST",
      new LambdaIntegration(bedrockStreamingFunction, {
        responseTransferMode: ResponseTransferMode.STREAM,
        timeout: STREAM_TIMEOUT,
      }),
    );

    //==============================================================================
    // OUTPUTS
    //==============================================================================

    new CfnOutput(this, "BedrockStreamingApiUrl", {
      value: bedrockStreamingApi.urlForPath(askResource.path),
      description: "API Gateway endpoint URL for Bedrock streaming",
    });
  }
}
