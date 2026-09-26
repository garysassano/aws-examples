export interface WeatherData {
  location: string;
  maxTemp: string;
  minTemp: string;
  precipitation: string;
  ttl: string;
}

export interface DynamoWeatherRecord {
  Location: string;
  MaxTemp: string;
  MinTemp: string;
  ChancesOfPrecipitation: string;
  TTL?: string;
}

export interface DynamoDBRecord {
  Item?: {
    Location?: { S: string };
    MaxTemp?: { N: string };
    MinTemp?: { N: string };
    ChancesOfPrecipitation?: { N: string };
    TTL?: { N: string };
  };
}
