import path from "node:path";
import { AttributeType, TableV2 } from "aws-cdk-lib/aws-dynamodb";
import { LoggingFormat, Runtime } from "aws-cdk-lib/aws-lambda";
import { type BundlingOptions, NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { Topic } from "aws-cdk-lib/aws-sns";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib/core";
import type { Construct } from "constructs";

export class MyStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    // Resources the handler calls, so both bundles are exercised end to end
    const parameter = new StringParameter(this, "MyParameter", {
      stringValue: "initial-value",
    });
    const bucket = new Bucket(this, "MyBucket", {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const table = new TableV2(this, "MyTable", {
      partitionKey: { name: "id", type: AttributeType.STRING },
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const topic = new Topic(this, "MyTopic");
    const queue = new Queue(this, "MyQueue");

    // Both functions share everything except how esbuild resolves dependencies
    const baseBundling: BundlingOptions = {
      minify: true,
      bundleAwsSDK: true, // Bundle the AWS SDK so its size shows up in both packages
    };
    const variants = [
      { id: "CjsLambda", functionName: "cjs-lambda", bundling: baseBundling },
      {
        id: "EsmLambda",
        functionName: "esm-lambda",
        bundling: {
          ...baseBundling,
          format: OutputFormat.ESM,
          mainFields: ["module", "main"], // Resolve each package's ESM build first, so esbuild can tree-shake it
        },
      },
    ];

    for (const { id, functionName, bundling } of variants) {
      const fn = new NodejsFunction(this, id, {
        functionName,
        runtime: Runtime.NODEJS_24_X,
        entry: path.join(import.meta.dirname, "..", "functions", "shared", "index.ts"),
        loggingFormat: LoggingFormat.JSON,
        memorySize: 1024,
        environment: {
          SSM_PARAMETER_NAME: parameter.parameterName,
          S3_BUCKET_NAME: bucket.bucketName,
          SQS_QUEUE_URL: queue.queueUrl,
          SNS_TOPIC_ARN: topic.topicArn,
          DYNAMODB_TABLE_NAME: table.tableName,
        },
        bundling,
      });

      parameter.grantRead(fn);
      bucket.grantWrite(fn);
      queue.grantSendMessages(fn);
      topic.grantPublish(fn);
      table.grantWriteData(fn);
    }
  }
}
