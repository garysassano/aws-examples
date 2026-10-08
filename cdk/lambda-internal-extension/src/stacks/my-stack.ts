import { join } from "node:path";
import { AttributeType, BillingMode, type CfnTable, Table } from "aws-cdk-lib/aws-dynamodb";
import {
  Effect,
  ManagedPolicy,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import {
  Code,
  Function,
  LayerVersion,
  LoggingFormat,
  Runtime,
  RuntimeFamily,
} from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { StringListParameter } from "aws-cdk-lib/aws-ssm";
import {
  CfnDeletionPolicy,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from "aws-cdk-lib/core";
import type { Construct } from "constructs";
import { getMaintenanceWindow } from "../utils/maintenance-window.js";

// Public preview runtime; aws-cdk-lib has no Runtime.PYTHON_3_15 constant yet.
const PYTHON_3_15 = new Runtime("python3.15", RuntimeFamily.PYTHON);

export class MyStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    const maintenanceWindowParameter = new StringListParameter(this, "MaintenanceWindow", {
      parameterName: "maintenance-window",
      stringListValue: getMaintenanceWindow(this.node.tryGetContext("maintenanceWindow")),
    });

    // Renamed along with the key change: CloudFormation cannot replace a custom-named table in place.
    // A replacement retains the previous table, so archived events awaiting replay survive it;
    // `cdk destroy` still deletes the current one.
    const maintenanceWindowEventsTable = new Table(this, "MaintenanceWindowEventsTable", {
      tableName: "maintenance-window-events",
      partitionKey: { name: "invoke_id", type: AttributeType.STRING },
      sortKey: { name: "timestamp", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    (maintenanceWindowEventsTable.node.defaultChild as CfnTable).cfnOptions.updateReplacePolicy =
      CfnDeletionPolicy.RETAIN;

    const maintenanceWindowLambdaLayer = new LayerVersion(this, "MaintenanceWindowLambdaLayer", {
      layerVersionName: "maintenance-window-layer",
      description: "Wrapper script + maintenance-window handler gate",
      code: Code.fromAsset(join(import.meta.dirname, "../layers/maintenance-window"), {
        exclude: ["**/__pycache__"],
      }),
      compatibleRuntimes: [PYTHON_3_15],
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const maintenanceWindowGatePolicy = new ManagedPolicy(this, "MaintenanceWindowGatePolicy", {
      managedPolicyName: "maintenance-window-gate-policy",
      description: "Lets the maintenance-window gate read the window and archive skipped events",
      document: new PolicyDocument({
        statements: [
          new PolicyStatement({
            effect: Effect.ALLOW,
            actions: ["dynamodb:PutItem"],
            resources: [maintenanceWindowEventsTable.tableArn],
          }),
          new PolicyStatement({
            effect: Effect.ALLOW,
            actions: ["ssm:GetParameter"],
            resources: [maintenanceWindowParameter.parameterArn],
          }),
        ],
      }),
    });

    const currentTimeRole = new Role(this, "CurrentTimeRole", {
      roleName: "current-time-role",
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        maintenanceWindowGatePolicy,
        ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      ],
    });

    // Stack-managed, so `cdk destroy` removes it; Lambda's own group would never expire.
    const currentTimeLogGroup = new LogGroup(this, "CurrentTimeLogGroup", {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    new Function(this, "CurrentTimeFunction", {
      functionName: "current-time",
      description: "Returns the current time, behind the maintenance-window gate",
      code: Code.fromAsset(join(import.meta.dirname, "../functions/current-time")),
      handler: "index.handler",
      runtime: PYTHON_3_15,
      role: currentTimeRole,
      // The gate's SDK calls take at most about 6 seconds before failing open.
      timeout: Duration.seconds(15),
      loggingFormat: LoggingFormat.JSON,
      logGroup: currentTimeLogGroup,
      environment: {
        AWS_LAMBDA_EXEC_WRAPPER: "/opt/maintenance-window-wrapper",
        MAINTENANCE_WINDOW_PARAMETER_NAME: maintenanceWindowParameter.parameterName,
        MAINTENANCE_WINDOW_TABLE_NAME: maintenanceWindowEventsTable.tableName,
      },
      layers: [maintenanceWindowLambdaLayer],
    });
  }
}
