import { CfnMapping, type Stack } from "aws-cdk-lib/core";

/**
 * ARNs of the AWS Lambda Layer for OpenTelemetry for Node.js, `AWSOpenTelemetryDistroJs`, which
 * replaces the legacy ADOT Lambda layer. Each Region publishes it from its own account and at its
 * own version, so the ARN is looked up instead of built from the Region.
 * @see https://aws-otel.github.io/docs/getting-started/lambda
 * @see https://github.com/aws-otel/aws-otel.github.io/blob/9de8bf4/src/config/lambdaLayerArns.js
 */
const ADOT_NODE_LAYER_ARNS: Record<string, string> = {
  "af-south-1": "arn:aws:lambda:af-south-1:904233096616:layer:AWSOpenTelemetryDistroJs:16",
  "ap-east-1": "arn:aws:lambda:ap-east-1:888577020596:layer:AWSOpenTelemetryDistroJs:16",
  "ap-east-2": "arn:aws:lambda:ap-east-2:412664885777:layer:AWSOpenTelemetryDistroJs:5",
  "ap-northeast-1": "arn:aws:lambda:ap-northeast-1:615299751070:layer:AWSOpenTelemetryDistroJs:16",
  "ap-northeast-2": "arn:aws:lambda:ap-northeast-2:615299751070:layer:AWSOpenTelemetryDistroJs:16",
  "ap-northeast-3": "arn:aws:lambda:ap-northeast-3:615299751070:layer:AWSOpenTelemetryDistroJs:16",
  "ap-south-1": "arn:aws:lambda:ap-south-1:615299751070:layer:AWSOpenTelemetryDistroJs:16",
  "ap-south-2": "arn:aws:lambda:ap-south-2:796973505492:layer:AWSOpenTelemetryDistroJs:16",
  "ap-southeast-1": "arn:aws:lambda:ap-southeast-1:615299751070:layer:AWSOpenTelemetryDistroJs:16",
  "ap-southeast-2": "arn:aws:lambda:ap-southeast-2:615299751070:layer:AWSOpenTelemetryDistroJs:16",
  "ap-southeast-3": "arn:aws:lambda:ap-southeast-3:039612877180:layer:AWSOpenTelemetryDistroJs:16",
  "ap-southeast-4": "arn:aws:lambda:ap-southeast-4:713881805771:layer:AWSOpenTelemetryDistroJs:16",
  "ap-southeast-5": "arn:aws:lambda:ap-southeast-5:152034782359:layer:AWSOpenTelemetryDistroJs:9",
  "ap-southeast-6": "arn:aws:lambda:ap-southeast-6:313828097273:layer:AWSOpenTelemetryDistroJs:4",
  "ap-southeast-7": "arn:aws:lambda:ap-southeast-7:980416031188:layer:AWSOpenTelemetryDistroJs:9",
  "ca-central-1": "arn:aws:lambda:ca-central-1:615299751070:layer:AWSOpenTelemetryDistroJs:16",
  "ca-west-1": "arn:aws:lambda:ca-west-1:595944127152:layer:AWSOpenTelemetryDistroJs:9",
  "cn-north-1": "arn:aws-cn:lambda:cn-north-1:440179912924:layer:AWSOpenTelemetryDistroJs:9",
  "cn-northwest-1":
    "arn:aws-cn:lambda:cn-northwest-1:440180067931:layer:AWSOpenTelemetryDistroJs:9",
  "eu-central-1": "arn:aws:lambda:eu-central-1:615299751070:layer:AWSOpenTelemetryDistroJs:16",
  "eu-central-2": "arn:aws:lambda:eu-central-2:156041407956:layer:AWSOpenTelemetryDistroJs:16",
  "eu-north-1": "arn:aws:lambda:eu-north-1:615299751070:layer:AWSOpenTelemetryDistroJs:16",
  "eu-south-1": "arn:aws:lambda:eu-south-1:257394471194:layer:AWSOpenTelemetryDistroJs:16",
  "eu-south-2": "arn:aws:lambda:eu-south-2:490004653786:layer:AWSOpenTelemetryDistroJs:16",
  "eu-west-1": "arn:aws:lambda:eu-west-1:615299751070:layer:AWSOpenTelemetryDistroJs:16",
  "eu-west-2": "arn:aws:lambda:eu-west-2:615299751070:layer:AWSOpenTelemetryDistroJs:16",
  "eu-west-3": "arn:aws:lambda:eu-west-3:615299751070:layer:AWSOpenTelemetryDistroJs:16",
  "il-central-1": "arn:aws:lambda:il-central-1:746669239226:layer:AWSOpenTelemetryDistroJs:16",
  "me-central-1": "arn:aws:lambda:me-central-1:739275441131:layer:AWSOpenTelemetryDistroJs:16",
  "me-south-1": "arn:aws:lambda:me-south-1:980921751758:layer:AWSOpenTelemetryDistroJs:12",
  "mx-central-1": "arn:aws:lambda:mx-central-1:610118373846:layer:AWSOpenTelemetryDistroJs:9",
  "sa-east-1": "arn:aws:lambda:sa-east-1:615299751070:layer:AWSOpenTelemetryDistroJs:16",
  "us-east-1": "arn:aws:lambda:us-east-1:615299751070:layer:AWSOpenTelemetryDistroJs:16",
  "us-east-2": "arn:aws:lambda:us-east-2:615299751070:layer:AWSOpenTelemetryDistroJs:16",
  "us-west-1": "arn:aws:lambda:us-west-1:615299751070:layer:AWSOpenTelemetryDistroJs:16",
  "us-west-2": "arn:aws:lambda:us-west-2:615299751070:layer:AWSOpenTelemetryDistroJs:16",
};

/** Returns the layer ARN for the stack's Region, failing synthesis in an unsupported Region. */
export const adotNodeLayerArn = (stack: Stack): string =>
  new CfnMapping(stack, "AdotNodeLayerArns", {
    mapping: Object.fromEntries(
      Object.entries(ADOT_NODE_LAYER_ARNS).map(([region, arn]) => [region, { arn }]),
    ),
    lazy: true,
  }).findInMap(stack.region, "arn");
