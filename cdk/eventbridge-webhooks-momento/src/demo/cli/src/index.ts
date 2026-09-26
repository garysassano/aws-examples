import { validateEnvVariables } from "./config.js";
import { DynamoService } from "./services/dynamoService.js";
import { MomentoService } from "./services/momentoService.js";
import { WeatherService } from "./services/weatherService.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  try {
    validateEnvVariables();

    const dynamoService = new DynamoService();
    const momentoService = new MomentoService();
    const weatherData = WeatherService.generateRandomWeatherData();

    // Subscribe to Momento topic
    await momentoService.subscribeToTopic();

    // Create DynamoDB record
    console.log("Creating weather record in DynamoDB...");
    await dynamoService.createWeatherRecord({
      Location: weatherData.location,
      MaxTemp: weatherData.maxTemp,
      MinTemp: weatherData.minTemp,
      ChancesOfPrecipitation: weatherData.precipitation,
      TTL: weatherData.ttl,
    });

    // Fetch and display DynamoDB record
    console.log("Fetching weather record from DynamoDB...");
    const record = await dynamoService.getWeatherRecord(weatherData.location);
    console.log("DynamoDB Record:", JSON.stringify(record, null, 2));

    // Wait for EventBridge and check cache
    await sleep(2000);
    console.log("Checking Momento cache...");
    const cacheItem = await momentoService.getItemFromCache(weatherData.location);
    console.log("Cache item:", cacheItem);

    // Cleanup
    momentoService.unsubscribeFromTopic();
  } catch (error) {
    console.error("Application error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

void main().then(() => console.log("Application completed successfully"));
