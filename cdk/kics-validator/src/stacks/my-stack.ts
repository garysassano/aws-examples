// import path from "node:path";

// import { AttributeType, TableV2 } from "aws-cdk-lib/aws-dynamodb";
// import { ManagedPolicy, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
// import { LogFormat, Runtime } from "aws-cdk-lib/aws-lambda";
// import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { Stack, type StackProps } from "aws-cdk-lib/core";
// import { Topic } from "aws-cdk-lib/aws-sns";
// import { Queue } from "aws-cdk-lib/aws-sqs";
// import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";

export class MyStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    // Generate a unique ID for resource naming
    const uniqueId = this.node.addr.substring(0, 8);

    new Bucket(this, "InsecureBucket", {
      bucketName: `insecure-bucket-${uniqueId}`,
    });
  }
}
