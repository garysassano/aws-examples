import { Logger } from "@aws-lambda-powertools/logger";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import middy from "@middy/core";
import httpErrorHandler from "@middy/http-error-handler";
import type { Handler } from "aws-lambda";

const logger = new Logger();
const ssmClient = new SSMClient();
const s3Client = new S3Client();
const sqsClient = new SQSClient();
const snsClient = new SNSClient();
const ddbStdClient = new DynamoDBClient();
const ddbClient = DynamoDBDocumentClient.from(ddbStdClient);

const lambdaHandler: Handler = async (_, context) => {
  const randomNumber = Math.floor(Math.random() * 100);
  logger.info(`Generated random number: ${randomNumber}`);

  // SSM operation: Get a parameter
  await ssmClient.send(
    new GetParameterCommand({
      Name: process.env.SSM_PARAMETER_NAME,
    }),
  );

  // S3 operation: Put an object
  await s3Client.send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: `random-number.txt`,
      Body: randomNumber.toString(),
    }),
  );

  // SQS operation: Send a message
  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: process.env.SQS_QUEUE_URL,
      MessageBody: randomNumber.toString(),
    }),
  );

  // SNS operation: Publish a message
  await snsClient.send(
    new PublishCommand({
      TopicArn: process.env.SNS_TOPIC_ARN,
      Message: randomNumber.toString(),
    }),
  );

  // DynamoDB operation: Put an item
  await ddbClient.send(
    new PutCommand({
      TableName: process.env.DYNAMODB_TABLE_NAME,
      Item: {
        id: context.awsRequestId,
        randomNumber,
      },
    }),
  );

  return {
    statusCode: 200,
    body: {
      message: "Operations completed successfully",
    },
  };
};

export const handler = middy(lambdaHandler).use(httpErrorHandler());
