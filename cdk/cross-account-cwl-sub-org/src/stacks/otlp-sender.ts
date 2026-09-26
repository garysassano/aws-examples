import { join } from "node:path";
import {
  Effect,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { Architecture, LoggingFormat, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { CfnAccountPolicy } from "aws-cdk-lib/aws-logs";
import { Duration, Stack, type StackProps } from "aws-cdk-lib/core";
import type { Construct } from "constructs";
import { validateEnv } from "../utils/validate-env.js";

const env = validateEnv(["CDK_ACCOUNT_SRC", "CDK_ACCOUNT_TRG", "CDK_REGION_SHARED"]);

export class OtlpSenderStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // IAM Role for Cross-Account CWL Account-level Subscription Filter Policy
    const otlpRole = new Role(this, "OtlpAccountSubscriptionFilterRole", {
      roleName: `OtlpAccountSubscriptionFilterRole_${this.region}`,
      assumedBy: new ServicePrincipal(`logs.${this.region}.amazonaws.com`),
      inlinePolicies: {
        KinesisDestinationWritePolicy: new PolicyDocument({
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ["logs:PutLogEvents"],
              resources: [
                `arn:aws:logs:${env.CDK_REGION_SHARED}:${env.CDK_ACCOUNT_SRC}:log-group:*`,
              ],
            }),
          ],
        }),
      },
    });

    // Cross-Account CWL Account-level Subscription Filter Policy
    new CfnAccountPolicy(this, "OtlpAccountSubscriptionFilterPolicy", {
      policyName: `OtlpAccountSubscriptionFilterPolicy_${this.region}`,
      policyType: "SUBSCRIPTION_FILTER_POLICY",
      scope: "ALL",
      policyDocument: JSON.stringify({
        DestinationArn: `arn:aws:logs:${env.CDK_REGION_SHARED}:${env.CDK_ACCOUNT_TRG}:destination:OtlpStreamDestination`,
        FilterPattern: "{ $.__otel_otlp_stdout = * }",
        Distribution: "Random",
        RoleArn: otlpRole.roleArn,
      }),
    });

    // Generic Lambda Function to Generate Logs for Cross-Account Testing
    new NodejsFunction(this, `HelloLambda`, {
      functionName: `hello-lambda`,
      entry: join(import.meta.dirname, "../functions/hello", "index.ts"),
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.minutes(1),
      loggingFormat: LoggingFormat.JSON,
    });
  }
}
