import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { Handler } from "aws-lambda";

const ssmClient = new SSMClient();
const s3Client = new S3Client();
const sqsClient = new SQSClient();
const snsClient = new SNSClient();
const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient());

export const handler: Handler = async (_, context) => {
  const randomNumber = Math.floor(Math.random() * 100);
  console.info(`Generated random number: ${randomNumber}`);

  await ssmClient.send(new GetParameterCommand({ Name: process.env.SSM_PARAMETER_NAME }));
  await s3Client.send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: "random-number.txt",
      Body: randomNumber.toString(),
    }),
  );
  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: process.env.SQS_QUEUE_URL,
      MessageBody: randomNumber.toString(),
    }),
  );
  await snsClient.send(
    new PublishCommand({
      TopicArn: process.env.SNS_TOPIC_ARN,
      Message: randomNumber.toString(),
    }),
  );
  await ddbClient.send(
    new PutCommand({
      TableName: process.env.DYNAMODB_TABLE_NAME,
      Item: { id: context.awsRequestId, randomNumber },
    }),
  );

  return { randomNumber };
};
