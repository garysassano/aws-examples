import {
  CacheClient,
  CacheGetResponse,
  Configurations,
  StringMomentoTokenProvider,
  TopicClient,
  TopicConfigurations,
  type TopicItem,
  type TopicSubscribe,
  TopicSubscribeResponse,
} from "@gomomento/sdk";
import { CONFIG } from "../config.js";

export class MomentoService {
  private subscription?: TopicSubscribe.Response;
  private topicClient: TopicClient;

  constructor() {
    this.topicClient = new TopicClient({
      configuration: TopicConfigurations.Default.latest(),
      credentialProvider: new StringMomentoTokenProvider(process.env.MOMENTO_API_KEY || ""),
    });
  }

  async getCacheClient(): Promise<CacheClient> {
    return await CacheClient.create({
      configuration: Configurations.Laptop.v1(),
      credentialProvider: new StringMomentoTokenProvider(process.env.MOMENTO_API_KEY || ""),
      defaultTtlSeconds: CONFIG.MOMENTO.DEFAULT_TTL_SECONDS,
    });
  }

  async subscribeToTopic(): Promise<void> {
    this.subscription = await this.topicClient.subscribe(
      CONFIG.MOMENTO.CACHE_NAME,
      CONFIG.MOMENTO.TOPIC_NAME,
      {
        onItem: this.handleItem,
        onError: this.handleError,
      },
    );

    if (this.subscription.type === TopicSubscribeResponse.Error) {
      throw new Error(`Failed to subscribe to topic: ${this.subscription.toString()}`);
    }

    console.log("Successfully subscribed to topic");
  }

  unsubscribeFromTopic(): void {
    if (this.subscription?.type === TopicSubscribeResponse.Subscription) {
      console.log("Unsubscribing from topic subscription");
      this.subscription.unsubscribe();
    }
  }

  async getItemFromCache(key: string): Promise<string> {
    const cacheClient = await this.getCacheClient();
    const response = await cacheClient.get(CONFIG.MOMENTO.CACHE_NAME, key);

    switch (response.type) {
      case CacheGetResponse.Hit:
        return response.valueString();
      case CacheGetResponse.Miss:
        return "Item not found in cache";
      default:
        return "Error getting item from cache";
    }
  }

  private handleItem(item: TopicItem): void {
    console.log(`Received item from topic subscription: ${item.valueString()}`);
  }

  private handleError(error: TopicSubscribe.Error): void {
    console.error(`Topic subscription error: ${error.toString()}`);
  }
}
