import { join } from "node:path";
import {
  Effect,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { Stream, StreamMode } from "aws-cdk-lib/aws-kinesis";
import { Architecture, LoggingFormat, Runtime, StartingPosition } from "aws-cdk-lib/aws-lambda";
import { KinesisEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { CfnDestination } from "aws-cdk-lib/aws-logs";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib/core";
import type { Construct } from "constructs";
import { validateEnv } from "../utils/validate-env.js";

const env = validateEnv(["CDK_ACCOUNT_TRG", "CDK_REGION_SHARED", "AWS_ORG_ID_SHARED"]);

export class OtlpReceiverStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    //==============================================================================
    // OTLP TRANSPORT (KINESIS)
    //==============================================================================

    // Kinesis stream for OTel traces
    const otlpStream = new Stream(this, "OtlpStream", {
      streamMode: StreamMode.ON_DEMAND,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Role assumed by CloudWatch Logs to write to the Kinesis stream
    const cwlToKinesisRole = new Role(this, "CwlToKinesisRole", {
      assumedBy: new ServicePrincipal("logs.amazonaws.com"),
      inlinePolicies: {
        KinesisWritePolicy: new PolicyDocument({
          statements: [
            new PolicyStatement({
              actions: ["kinesis:PutRecord"],
              resources: [otlpStream.streamArn],
              effect: Effect.ALLOW,
            }),
          ],
        }),
      },
    });

    // CloudWatch Logs Destination
    const otlpStreamDestination = new CfnDestination(this, "OtlpStreamDestination", {
      destinationName: "OtlpStreamDestination",
      targetArn: otlpStream.streamArn,
      roleArn: cwlToKinesisRole.roleArn,
      destinationPolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: "*",
            Action: ["logs:PutSubscriptionFilter", "logs:PutAccountPolicy"],
            Resource: `arn:aws:logs:${env.CDK_REGION_SHARED}:${env.CDK_ACCOUNT_TRG}:destination:OtlpStreamDestination`,
            Condition: {
              StringEquals: {
                "aws:PrincipalOrgID": [env.AWS_ORG_ID_SHARED],
              },
            },
          },
        ],
      }),
    });

    //==============================================================================
    // CROSS OTLP LOGGER (LAMBDA)
    //==============================================================================

    // Generic Lambda function to process OTel traces from Kinesis
    const crossOtlpLoggerLambda = new NodejsFunction(this, `CrossOtlpLoggerLambda`, {
      functionName: "cross-otlp-logger-lambda",
      entry: join(import.meta.dirname, "../functions/cross-otlp-logger", "index.ts"),
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.minutes(1),
      loggingFormat: LoggingFormat.JSON,
    });

    // Add Kinesis as an event source for the Lambda function
    crossOtlpLoggerLambda.addEventSource(
      new KinesisEventSource(otlpStream, {
        startingPosition: StartingPosition.LATEST,
        batchSize: 10000,
        maxBatchingWindow: Duration.seconds(5),
        parallelizationFactor: 1,
        reportBatchItemFailures: false,
        bisectBatchOnError: false,
      }),
    );

    //==============================================================================
    // CFN OUTPUTS
    //==============================================================================

    new CfnOutput(this, "LogDestinationArn", {
      value: otlpStreamDestination.attrArn,
      description: "ARN of the CloudWatch Logs Destination for cross-account subscriptions",
    });
  }
}
