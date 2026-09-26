import {
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";

// Create DynamoDB client using default credentials chain
const ddbClient = new DynamoDBClient({});

export const tableName = "weather-stats-demo";

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
    TTL: { N: ttl },
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
