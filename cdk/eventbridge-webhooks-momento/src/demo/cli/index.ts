import { styleText } from "node:util";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  CacheClient,
  CacheGetResponse,
  Configurations,
  CredentialProvider,
  TopicClient,
  TopicConfigurations,
  type TopicSubscribe,
  TopicSubscribeResponse,
} from "@gomomento/sdk";

// Names the CDK stack gives these resources.
const TABLE_NAME = "weather-stats-table";
const CACHE_NAME = "momento-eventbridge-cache";
const TOPIC_NAME = "momento-eventbridge-topic";

const TTL_SECONDS = 120;
// The pipes deliver asynchronously, so poll the cache for up to this long.
const WAIT_SECONDS = 10;

const log = {
  step: (message: string) => console.log(`\n${styleText("blue", "→")} ${message}`),
  success: (message: string) => console.log(`${styleText("green", "✔")} ${message}`),
  data: (label: string, value: unknown) => {
    console.log(styleText("cyan", label));
    console.dir(value, { depth: null, colors: true });
  },
};

const LOCATIONS = ["Seattle", "New York", "Los Angeles", "Chicago", "Houston"];

function randomWeather() {
  const maxTemp = Math.floor(Math.random() * 100);
  return {
    Location: LOCATIONS[Math.floor(Math.random() * LOCATIONS.length)],
    MaxTemp: maxTemp,
    MinTemp: Math.floor(Math.random() * maxTemp),
    ChancesOfPrecipitation: Math.floor(Math.random() * 100),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Polls the cache until the key holds a value (or, with present = false, no longer does).
async function waitForCache(cache: CacheClient, key: string, present: boolean) {
  const start = Date.now();
  for (let attempt = 0; attempt < WAIT_SECONDS * 4; attempt++) {
    const response = await cache.get(CACHE_NAME, key);
    if (response.type === CacheGetResponse.Error) {
      throw new Error(`Cache get failed: ${response.message()}`);
    }
    if ((response.type === CacheGetResponse.Hit) === present) {
      return {
        value: response.type === CacheGetResponse.Hit ? JSON.parse(response.valueString()) : null,
        afterMs: Date.now() - start,
      };
    }
    await sleep(250);
  }
  throw new Error(
    `The cache didn't ${present ? "receive" : "drop"} ${key} within ${WAIT_SECONDS}s`,
  );
}

async function main() {
  const missing = ["MOMENTO_API_KEY", "MOMENTO_ENDPOINT"].filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Set ${missing.join(" and ")} in the environment or in .env`);
  }

  // Reads the v2 API key and the endpoint from MOMENTO_API_KEY and MOMENTO_ENDPOINT.
  const credentialProvider = CredentialProvider.fromEnvVarV2();
  const cache = await CacheClient.create({
    configuration: Configurations.Laptop.latest(),
    credentialProvider,
    defaultTtlSeconds: TTL_SECONDS,
  });
  const topic = new TopicClient({
    configuration: TopicConfigurations.Default.latest(),
    credentialProvider,
  });
  const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  let subscription: TopicSubscribe.Subscription | undefined;

  try {
    log.step(`Subscribing to the ${TOPIC_NAME} topic`);
    const response = await topic.subscribe(CACHE_NAME, TOPIC_NAME, {
      onItem: (item) => log.data("Topic message:", JSON.parse(item.valueString())),
      onError: (error) => console.error(styleText("red", `Topic error: ${error.message()}`)),
    });
    if (response.type === TopicSubscribeResponse.Error) {
      throw new Error(`Couldn't subscribe: ${response.message()}`);
    }
    subscription = response;

    const weather = randomWeather();
    log.step(`Putting a record for ${weather.Location} in the ${TABLE_NAME} table`);
    await dynamodb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          ...weather,
          // DynamoDB TTL takes an epoch time; the cache put pipe passes TtlSeconds to Momento.
          TTL: Math.floor(Date.now() / 1000) + TTL_SECONDS,
          TtlSeconds: TTL_SECONDS,
        },
      }),
    );
    log.data("Saved:", weather);

    log.step(`Waiting for the pipe to put it in the ${CACHE_NAME} cache`);
    const put = await waitForCache(cache, weather.Location, true);
    log.success(`In the cache after ${put.afterMs} ms`);
    log.data("Cached value:", put.value);

    log.step("Deleting the record from the table");
    await dynamodb.send(
      new DeleteCommand({ TableName: TABLE_NAME, Key: { Location: weather.Location } }),
    );

    log.step("Waiting for the pipe to delete it from the cache");
    const deleted = await waitForCache(cache, weather.Location, false);
    log.success(`Gone from the cache after ${deleted.afterMs} ms`);

    // Give the REMOVE message a moment to arrive before unsubscribing.
    await sleep(2000);
    console.log(`\n${styleText("green", "Demo completed")}`);
  } finally {
    subscription?.unsubscribe();
    cache.close();
  }
}

main().catch((error: unknown) => {
  console.error(styleText("red", `✖ ${error instanceof Error ? error.message : error}`));
  process.exitCode = 1;
});
