import { join } from "node:path";
import { PythonLayerVersion } from "@aws-cdk/aws-lambda-python-alpha";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import {
  Effect,
  ManagedPolicy,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { Code, Function, Runtime } from "aws-cdk-lib/aws-lambda";
import { StringListParameter } from "aws-cdk-lib/aws-ssm";
import { RemovalPolicy, Stack, type StackProps, Validations } from "aws-cdk-lib/core";
import type { Construct } from "constructs";

// Function and layer code live in the Python package next to src/.
const codeRoot = join(import.meta.dirname, "../../cdk_aws_lambda_internal_extension");

// Midnight today to midnight tomorrow, computed at synth time.
function getMaintenanceWindow(): string[] {
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  const midnight = (d: Date) => `${d.toISOString().slice(0, 10)}T00:00:00Z`;
  return [midnight(today), midnight(tomorrow)];
}

export class MyStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    new StringListParameter(this, "MaintenanceWindow", {
      parameterName: "maintenance-window",
      stringListValue: getMaintenanceWindow(),
    });

    new Table(this, "MaintenanceWindowEventsTable", {
      tableName: "maintenance-window-events-table",
      partitionKey: { name: "timestamp", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Build Python Lambda layer inside Docker
    const maintenanceWindowLambdaLayer = new PythonLayerVersion(
      this,
      "MaintenanceWindowLambdaLayer",
      {
        layerVersionName: "maintenance-window-layer",
        description: "Wrapper script + Forked awslambdaric",
        entry: join(codeRoot, "layers", "maintenance-window"),
        compatibleRuntimes: [Runtime.PYTHON_3_9],
        removalPolicy: RemovalPolicy.DESTROY,
      },
    );

    const lambdaPreHandlerPolicy = new ManagedPolicy(this, "LambdaPreHandlerPolicy", {
      managedPolicyName: "lambda-pre-handler-policy",
      description: "Lambda pre-handler customer managed policy",
      document: new PolicyDocument({
        statements: [
          new PolicyStatement({
            effect: Effect.ALLOW,
            actions: ["dynamodb:PutItem", "ssm:GetParameter"],
            resources: ["*"],
          }),
        ],
      }),
    });

    const testLambdaRole = new Role(this, "TestLambdaRole", {
      roleName: "test-lambda-role",
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        lambdaPreHandlerPolicy,
        ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      ],
    });

    const testLambda = new Function(this, "TestLambda", {
      functionName: "test-lambda",
      description: "Lambda for testing maintenance window",
      code: Code.fromAsset(join(codeRoot, "functions", "test")),
      handler: "index.handler",
      runtime: Runtime.PYTHON_3_9,
      role: testLambdaRole,
      environment: { AWS_LAMBDA_EXEC_WRAPPER: "/opt/python/wrapper-script" },
      layers: [maintenanceWindowLambdaLayer],
    });

    // The layer's wrapper script execs /var/lang/bin/python3.9, so the function
    // stays on python3.9 until the forked runtime is moved to a newer Python.
    Validations.of(testLambda).acknowledge({
      id: "CloudFormation-Validate::W2531",
      reason: "Pinned to python3.9 by the maintenance-window layer's wrapper script",
    });
  }
}
