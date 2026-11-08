import path from "node:path";
import { CfnWorkGroup } from "aws-cdk-lib/aws-athena";
import { AttributeType, TableV2 } from "aws-cdk-lib/aws-dynamodb";
import { CfnDatabase, CfnTable } from "aws-cdk-lib/aws-glue";
import { Alias, Architecture, LoggingFormat, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib/core";
import type { Construct } from "constructs";
import {
  ALIAS_NAME,
  ATHENA_WORKGROUP_NAME,
  FUNCTION_NAME,
  GLUE_DATABASE_NAME,
  GLUE_TABLE_NAME,
  TELEMETRY_PREFIX,
  TELEMETRY_TABLE_NAME,
} from "../constants.js";

// Record keys with an uppercase letter. Glue columns are lowercase, so the JSON SerDe maps each
// column back to its key; this lets it stay case-sensitive, which keeps the keys inside `input`
// and `output` readable with json_extract.
const CAMEL_CASE_KEYS = [
  "recordType",
  "schemaVersion",
  "emittedAt",
  "executionArn",
  "executionName",
  "functionName",
  "functionQualifier",
  "accountId",
  "startTime",
  "endTime",
  "durationMs",
  "droppedCauses",
  "droppedOperations",
  "droppedInput",
  "droppedOutput",
  "subType",
  "parentId",
];

const ERROR = "struct<name:string,message:string>";
const OPERATION = `struct<id:string,name:string,type:string,subtype:string,parentid:string,status:string,starttime:timestamp,endtime:timestamp,durationms:bigint,attempt:int,error:${ERROR},result:string,truncated:boolean>`;

export class MyStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    // Telemetry destinations
    const table = new TableV2(this, "TelemetryTable", {
      tableName: TELEMETRY_TABLE_NAME,
      partitionKey: { name: "pk", type: AttributeType.STRING }, // execution ARN
      sortKey: { name: "sk", type: AttributeType.STRING }, // emit time, so each record is kept
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const bucket = new Bucket(this, "TelemetryBucket", {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Athena reads the S3 exporter's objects through a Glue table. Partition projection computes
    // the year/month/day partitions from the key layout, so new days need no crawler or repair.
    const database = new CfnDatabase(this, "TelemetryDatabase", {
      catalogId: this.account,
      databaseInput: { name: GLUE_DATABASE_NAME },
    });
    const location = bucket.s3UrlForObject(TELEMETRY_PREFIX);
    const glueTable = new CfnTable(this, "TelemetryGlueTable", {
      catalogId: this.account,
      databaseName: GLUE_DATABASE_NAME,
      tableInput: {
        name: GLUE_TABLE_NAME,
        tableType: "EXTERNAL_TABLE",
        parameters: {
          "projection.enabled": "true",
          "projection.year.type": "integer",
          "projection.year.range": "2026,2099",
          "projection.month.type": "integer",
          "projection.month.range": "1,12",
          "projection.month.digits": "2",
          "projection.day.type": "integer",
          "projection.day.range": "1,31",
          "projection.day.digits": "2",
          "storage.location.template": `${location}year=\${year}/month=\${month}/day=\${day}`,
        },
        partitionKeys: [
          { name: "year", type: "string" },
          { name: "month", type: "string" },
          { name: "day", type: "string" },
        ],
        storageDescriptor: {
          location,
          inputFormat: "org.apache.hadoop.mapred.TextInputFormat",
          outputFormat: "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat",
          serdeInfo: {
            serializationLibrary: "org.openx.data.jsonserde.JsonSerDe",
            parameters: {
              "case.insensitive": "false",
              ...Object.fromEntries(
                CAMEL_CASE_KEYS.map((key) => [`mapping.${key.toLowerCase()}`, key]),
              ),
            },
          },
          columns: [
            { name: "recordtype", type: "string" },
            { name: "schemaversion", type: "string" },
            { name: "emittedat", type: "timestamp" },
            { name: "executionarn", type: "string" },
            { name: "executionname", type: "string" },
            { name: "functionname", type: "string" },
            { name: "functionqualifier", type: "string" },
            { name: "region", type: "string" },
            { name: "accountid", type: "string" },
            { name: "status", type: "string" },
            { name: "starttime", type: "timestamp" },
            { name: "endtime", type: "timestamp" },
            { name: "durationms", type: "bigint" },
            { name: "input", type: "string" },
            { name: "output", type: "string" },
            { name: "error", type: ERROR },
            { name: "operations", type: `array<${OPERATION}>` },
            { name: "truncated", type: "boolean" },
            { name: "droppedcauses", type: "boolean" },
            { name: "droppedoperations", type: "int" },
            { name: "droppedinput", type: "boolean" },
            { name: "droppedoutput", type: "boolean" },
          ],
        },
      },
    });
    glueTable.addResourceDependency(database);

    // Query results go outside the table's location, so Athena never reads them back as records.
    new CfnWorkGroup(this, "TelemetryWorkGroup", {
      name: ATHENA_WORKGROUP_NAME,
      recursiveDeleteOption: true,
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        resultConfiguration: { outputLocation: bucket.s3UrlForObject("athena-results/") },
      },
    });

    // The durable function
    const fn = new NodejsFunction(this, "OrderWorkflow", {
      functionName: FUNCTION_NAME,
      entry: path.join(import.meta.dirname, "..", "functions", "order-workflow", "index.ts"),
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      // Bounds each invocation; the execution as a whole, waits included, gets executionTimeout.
      timeout: Duration.seconds(30),
      loggingFormat: LoggingFormat.JSON,
      // Also swaps the role's basic execution policy for AWSLambdaBasicDurableExecutionRolePolicy,
      // which adds the checkpoint and state permissions.
      durableConfig: {
        executionTimeout: Duration.minutes(15),
        retentionPeriod: Duration.days(1),
      },
      environment: {
        TELEMETRY_TABLE_NAME: table.tableName,
        TELEMETRY_BUCKET_NAME: bucket.bucketName,
      },
      bundling: {
        format: OutputFormat.ESM,
        mainFields: ["module", "main"],
        minify: true,
        // Records carry each error's class name, which minifying would mangle (StepError -> Zh).
        keepNames: true,
        // Pin the AWS SDK clients that the durable SDK and the exporter import, rather than use the
        // runtime's copy. The exporter imports a client for every destination it supports.
        bundleAwsSDK: true,
      },
    });

    // Exactly what the two exporters call
    table.grant(fn, "dynamodb:PutItem");
    bucket.grantPut(fn, `${TELEMETRY_PREFIX}*`);

    new Alias(this, "LiveAlias", {
      aliasName: ALIAS_NAME,
      version: fn.currentVersion,
    });

    new CfnOutput(this, "TelemetryBucketName", { value: bucket.bucketName });
  }
}
