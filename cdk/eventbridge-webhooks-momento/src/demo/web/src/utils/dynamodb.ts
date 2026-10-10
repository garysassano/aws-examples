import {
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { REGION } from "./constants";

// A browser has no default credential chain, so the local dev server passes
// credentials in through VITE_ variables. Never build this app for hosting.
const ddbClient = new DynamoDBClient({
  region: REGION,
  credentials: {
    accessKeyId: import.meta.env.VITE_AWS_ACCESS_KEY_ID,
    secretAccessKey: import.meta.env.VITE_AWS_SECRET_ACCESS_KEY,
    sessionToken: import.meta.env.VITE_AWS_SESSION_TOKEN || undefined,
  },
});

export const tableName = "weather-stats-table";

export function createRecord(
  location: string,
  maxTemp: string,
  minTemp: string,
  precipitation: string,
  ttl: string,
) {
  const item = {
    Location: { S: location },
    MaxTemp: { N: maxTemp },
    MinTemp: { N: minTemp },
    ChancesOfPrecipitation: { N: precipitation },
    // DynamoDB TTL takes an epoch time; the cache put pipe passes TtlSeconds to Momento.
    TTL: { N: String(Math.floor(Date.now() / 1000) + Number(ttl)) },
    TtlSeconds: { N: ttl },
  };
  const command = new PutItemCommand({
    TableName: tableName,
    Item: item,
  });

  return ddbClient.send(command);
}

export function getRecord(location: string) {
  const command = new GetItemCommand({
    TableName: tableName,
    Key: {
      Location: { S: location },
    },
  });

  return ddbClient.send(command);
}

export function deleteRecord(location: string) {
  const command = new DeleteItemCommand({
    TableName: tableName,
    Key: {
      Location: { S: location },
    },
  });

  return ddbClient.send(command);
}
