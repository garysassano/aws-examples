import { DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { CONFIG } from "../config.js";
import type { DynamoDBRecord, DynamoWeatherRecord } from "../types.js";

export class DynamoService {
  private client: DynamoDBClient;

  constructor() {
    this.client = new DynamoDBClient();
  }

  async createWeatherRecord(data: DynamoWeatherRecord): Promise<void> {
    const params = {
      TableName: CONFIG.DYNAMO.TABLE_NAME,
      Item: {
        Location: { S: data.Location },
        MaxTemp: { N: data.MaxTemp },
        MinTemp: { N: data.MinTemp },
        ChancesOfPrecipitation: { N: data.ChancesOfPrecipitation },
        TTL: { N: data.TTL || "120" },
      },
    };

    await this.client.send(new PutItemCommand(params));
  }

  async getWeatherRecord(location: string): Promise<DynamoWeatherRecord | null> {
    const params = {
      TableName: CONFIG.DYNAMO.TABLE_NAME,
      Key: {
        Location: { S: location },
      },
    };

    const response = await this.client.send(new GetItemCommand(params));
    return this.parseDynamoRecord(response);
  }

  private parseDynamoRecord(record: DynamoDBRecord): DynamoWeatherRecord | null {
    const { Item } = record;
    if (
      !Item?.Location?.S ||
      !Item?.MaxTemp?.N ||
      !Item?.MinTemp?.N ||
      !Item?.ChancesOfPrecipitation?.N
    ) {
      return null;
    }

    return {
      Location: Item.Location.S,
      MaxTemp: Item.MaxTemp.N,
      MinTemp: Item.MinTemp.N,
      ChancesOfPrecipitation: Item.ChancesOfPrecipitation.N,
      TTL: Item.TTL?.N,
    };
  }
}
