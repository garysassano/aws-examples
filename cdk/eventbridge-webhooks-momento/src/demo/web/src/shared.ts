// Names the CDK stack gives these resources.
export const TABLE_NAME = "weather-stats-table";
export const CACHE_NAME = "momento-eventbridge-cache";
export const TOPIC_NAME = "momento-eventbridge-topic";

export type WeatherRecord = {
  location: string;
  maxTemp: number;
  minTemp: number;
  precipitation: number;
  ttlSeconds: number;
};
