import path from "node:path";
import { AttributeType, TableV2 } from "aws-cdk-lib/aws-dynamodb";
import { ManagedPolicy, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { LoggingFormat, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { Topic } from "aws-cdk-lib/aws-sns";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { Stack, type StackProps } from "aws-cdk-lib/core";
import type { Construct } from "constructs";

export class MyStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    // Generate a unique ID for resource naming
    const uniqueId = this.node.addr.substring(0, 8);

    // Create resources
    const parameter = new StringParameter(this, "MyParameter", {
      parameterName: `my-parameter-${uniqueId}`,
      stringValue: "initial-value",
    });
    const bucket = new Bucket(this, "MyBucket", {
      bucketName: `my-bucket-${uniqueId}`,
    });
    const table = new TableV2(this, "MyTable", {
      tableName: `my-table-${uniqueId}`,
      partitionKey: { name: "id", type: AttributeType.STRING },
    });
    const topic = new Topic(this, "MyTopic", {
      topicName: `my-topic-${uniqueId}`,
    });
    const queue = new Queue(this, "MyQueue", {
      queueName: `my-queue-${uniqueId}`,
    });

    // Create Lambda role
    const sharedLambdaRole = new Role(this, "SharedLambdaRole", {
      roleName: `shared-lambda-role`,
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      ],
    });

    // Add policies for using the resources
    parameter.grantRead(sharedLambdaRole);
    bucket.grantWrite(sharedLambdaRole);
    queue.grantSendMessages(sharedLambdaRole);
    topic.grantPublish(sharedLambdaRole);
    table.grantWriteData(sharedLambdaRole);

    // Create function from ESM bundle
    new NodejsFunction(this, "EsmLambda", {
      functionName: "esm-lambda",
      runtime: Runtime.NODEJS_24_X,
      entry: path.join(import.meta.dirname, "..", "functions", "shared", "index.ts"),
      role: sharedLambdaRole,
      loggingFormat: LoggingFormat.JSON,
      memorySize: 1024,
      environment: {
        SSM_PARAMETER_NAME: parameter.parameterName,
        S3_BUCKET_NAME: bucket.bucketName,
        SQS_QUEUE_URL: queue.queueUrl,
        SNS_TOPIC_ARN: topic.topicArn,
        DYNAMODB_TABLE_NAME: table.tableName,
      },
      bundling: {
        // EXTRA VISIBILITY
        metafile: true, // Generates a metafile for detailed insights on the bundle composition
        sourceMap: true, // Generates source maps to facilitate debugging by mapping the compiled code back to the original source code
        // BASIC OPTIMIZATIONS
        minify: true, // Minifies the code to reduce the size of the bundle
        bundleAwsSDK: true, // Allows to bundle your own AWS SDK instead of using Lambda Provided SDK
        // ESM OPTIMIZATIONS
        format: OutputFormat.ESM, // Sets the output format of the bundle to ESM
        mainFields: ["module", "main"], // Determines the entrypoint of a module by prioritizing the ESM version if available, otherwise falling back to its CJS version
        banner: "const require = (await import('node:module')).createRequire(import.meta.url);", // Polyfills the `require` function in ESM output, enabling the use of CJS modules within an ESM bundle
      },
    });

    // Create function from CJS bundle
    new NodejsFunction(this, "CjsLambda", {
      functionName: "cjs-lambda",
      runtime: Runtime.NODEJS_24_X,
      entry: path.join(import.meta.dirname, "..", "functions", "shared", "index.ts"),
      role: sharedLambdaRole,
      loggingFormat: LoggingFormat.JSON,
      memorySize: 1024,
      environment: {
        SSM_PARAMETER_NAME: parameter.parameterName,
        S3_BUCKET_NAME: bucket.bucketName,
        SQS_QUEUE_URL: queue.queueUrl,
        SNS_TOPIC_ARN: topic.topicArn,
        DYNAMODB_TABLE_NAME: table.tableName,
      },
      bundling: {
        // EXTRA VISIBILITY
        metafile: true, // Generates a metafile for detailed insights on the bundle composition
        sourceMap: true, // Generates source maps to facilitate debugging by mapping the compiled code back to the original source code
        // BASIC OPTIMIZATIONS
        minify: true, // Minifies the code to reduce the size of the bundle
        bundleAwsSDK: true, // Allows to bundle your own AWS SDK instead of using Lambda Provided SDK
      },
    });
  }
}
