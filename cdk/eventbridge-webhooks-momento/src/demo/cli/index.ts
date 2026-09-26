import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import {
  CacheClient,
  CacheGetResponse,
  Configurations,
  StringMomentoTokenProvider,
  TopicClient,
  TopicConfigurations,
  TopicSubscribeResponse,
} from "@gomomento/sdk";
import chalk from "chalk";

// Configuration
const CONFIG = {
  DYNAMO_TABLE: "weather-stats-table",
  MOMENTO: {
    CACHE_NAME: "momento-eventbridge-cache",
    TOPIC_NAME: "momento-eventbridge-topic",
    TTL_SECONDS: 120,
  },
} as const;

// Logging helpers
const log = {
  info: (msg: string) => console.log(chalk.blue("ℹ ") + msg),
  success: (msg: string) => console.log(chalk.green("✔ ") + msg),
  warn: (msg: string) => console.log(chalk.yellow("⚠ ") + msg),
  error: (msg: string) => console.log(chalk.red("✖ ") + msg),
  group: (header: { icon: string; text: string }, details: { label: string; value: string }[]) => {
    console.log("\n" + chalk.blue(header.icon) + chalk.gray(` ${header.text}`));
    details.forEach((detail) => {
      console.log(chalk.gray(`  → ${detail.label}: `) + chalk.cyan(detail.value));
    });
  },
  data: (msg: string, obj: any) => {
    console.log("\n" + chalk.cyan(msg));
    console.dir(obj, { depth: null, colors: true });
  },
};

// Weather Generation
const LOCATIONS = ["Seattle", "New York", "Los Angeles", "Chicago", "Houston"] as const;

function generateWeatherData() {
  return {
    location: LOCATIONS[Math.floor(Math.random() * LOCATIONS.length)],
    maxTemp: Math.floor(Math.random() * 100).toString(),
    minTemp: Math.floor(Math.random() * 50).toString(),
    precipitation: Math.floor(Math.random() * 100).toString(),
  };
}

// DynamoDB Operations
const dynamoClient = new DynamoDBClient({});

async function saveToDatabase(data: ReturnType<typeof generateWeatherData>) {
  const params = {
    TableName: CONFIG.DYNAMO_TABLE,
    Item: {
      Location: { S: data.location },
      MaxTemp: { N: data.maxTemp },
      MinTemp: { N: data.minTemp },
      ChancesOfPrecipitation: { N: data.precipitation },
      TTL: { N: CONFIG.MOMENTO.TTL_SECONDS.toString() },
    },
  };

  await dynamoClient.send(new PutItemCommand(params));
}

// Momento Operations
async function getFromCache(key: string): Promise<string> {
  log.group({ icon: "🔍", text: "Searching in cache..." }, [
    { label: "Cache", value: CONFIG.MOMENTO.CACHE_NAME },
    { label: "Key", value: key },
  ]);
  const client = await CacheClient.create({
    configuration: Configurations.Laptop.v1(),
    credentialProvider: new StringMomentoTokenProvider(process.env.MOMENTO_API_KEY || ""),
    defaultTtlSeconds: CONFIG.MOMENTO.TTL_SECONDS,
  });

  const response = await client.get(CONFIG.MOMENTO.CACHE_NAME, key);
  if (response.type === CacheGetResponse.Hit) {
    const data = JSON.parse(response.valueString());
    return data;
  }
  return "Not found in cache";
}

async function subscribeToTopic() {
  log.group({ icon: "🔧", text: "Setting up topic..." }, [
    { label: "Topic", value: CONFIG.MOMENTO.TOPIC_NAME },
  ]);
  const topicClient = new TopicClient({
    configuration: TopicConfigurations.Default.latest(),
    credentialProvider: new StringMomentoTokenProvider(process.env.MOMENTO_API_KEY || ""),
  });

  const subscription = await topicClient.subscribe(
    CONFIG.MOMENTO.CACHE_NAME,
    CONFIG.MOMENTO.TOPIC_NAME,
    {
      onItem: (item) => {
        const data = JSON.parse(item.valueString());
        log.data("📦 Received from topic:", data);
      },
      onError: (error) => log.error(`Topic subscription error: ${error}`),
    },
  );

  if (subscription.type === TopicSubscribeResponse.Error) {
    throw new Error(`Failed to subscribe: ${subscription.toString()}`);
  }

  return subscription;
}

// Utility
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Main Application
async function main() {
  try {
    if (!process.env.MOMENTO_API_KEY) {
      throw new Error("MOMENTO_API_KEY environment variable is required");
    }

    log.info(chalk.bold("\n🌤  Weather Stats Demo\n"));

    const weatherData = generateWeatherData();
    console.log(chalk.blue("ℹ ") + chalk.gray("Random weather data ready"));

    const subscription = await subscribeToTopic();
    console.log(
      "\n" + chalk.green("✔ ") + `Subscribed to topic: ${chalk.cyan(CONFIG.MOMENTO.TOPIC_NAME)}`,
    );

    // Save to DynamoDB
    log.group({ icon: "📤", text: "Uploading to DynamoDB..." }, [
      { label: "Table", value: CONFIG.DYNAMO_TABLE },
    ]);
    await saveToDatabase(weatherData);
    log.data("💾 Saved to DynamoDB:", weatherData);

    // Wait for EventBridge and check cache
    console.log(
      "\n" +
        chalk.blue("ℹ ") +
        chalk.gray(
          `Waiting ${CONFIG.MOMENTO.TTL_SECONDS / 60} minutes for EventBridge propagation...`,
        ),
    );
    await sleep(2000);

    const cacheValue = await getFromCache(weatherData.location);
    log.data("📦 Retrieved from cache:", cacheValue);

    // Cleanup
    if (subscription.type === TopicSubscribeResponse.Subscription) {
      subscription.unsubscribe();
      console.log(
        "\n" +
          chalk.green("✔ ") +
          `Unsubscribed from topic: ${chalk.cyan(CONFIG.MOMENTO.TOPIC_NAME)}`,
      );
    }
  } catch (error) {
    log.error(`Application error: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

void main().then(() => console.log("\n" + chalk.green("🎉 Demo completed successfully!")));
