import {
  CacheClient,
  CacheGetResponse,
  CacheItemGetTtlResponse,
  Configurations,
  CredentialProvider,
  MomentoErrorCode,
  TopicClient,
  TopicConfigurations,
  type TopicSubscribe,
  TopicSubscribeResponse,
} from "@gomomento/sdk-web";
import { getMomentoToken } from "./api";
import { CACHE_NAME, TOPIC_NAME } from "./shared";

type Clients = { cache: CacheClient; topic: TopicClient; expiresAt: number };

let current: Clients | undefined;
let pending: Promise<Clients> | undefined;

// Both clients share one disposable token from the dev server, renewed a minute before it expires.
async function getClients(): Promise<Clients> {
  if (current && current.expiresAt * 1000 - Date.now() > 60_000) {
    return current;
  }
  pending ??= getMomentoToken()
    .then(({ token, expiresAt }) => {
      const credentialProvider = CredentialProvider.fromDisposableToken(token);
      return {
        cache: new CacheClient({
          configuration: Configurations.Browser.latest(),
          credentialProvider,
          defaultTtlSeconds: 60,
        }),
        topic: new TopicClient({
          configuration: TopicConfigurations.Browser.latest(),
          credentialProvider,
        }),
        expiresAt,
      };
    })
    .finally(() => {
      pending = undefined;
    });
  current = await pending;
  return current;
}

export type CacheItem = { value: string; remainingTtlSeconds?: number };

export async function getCacheItem(key: string): Promise<CacheItem | null> {
  const { cache } = await getClients();
  const item = await cache.get(CACHE_NAME, key);
  if (item.type === CacheGetResponse.Miss) {
    return null;
  }
  if (item.type === CacheGetResponse.Error) {
    // The token may have expired, so the next lookup starts with a fresh one.
    current = undefined;
    throw new Error(item.message());
  }
  const ttl = await cache.itemGetTtl(CACHE_NAME, key);
  return {
    value: item.valueString(),
    remainingTtlSeconds:
      ttl.type === CacheItemGetTtlResponse.Hit
        ? Math.round(ttl.remainingTtlMillis() / 1000)
        : undefined,
  };
}

export type TopicStatus =
  | { state: "connecting" | "subscribed" | "reconnecting" }
  | { state: "failed"; message: string; cacheMissing: boolean };

/**
 * Subscribes to the topic, and subscribes again with a new token when the subscription fails,
 * for example because the token expired. Returns a function that ends the subscription.
 */
export function subscribeToTopic(
  onMessage: (text: string) => void,
  onStatus: (status: TopicStatus) => void,
): () => void {
  let stopped = false;
  let subscription: TopicSubscribe.Subscription | undefined;
  let failures = 0;

  const retry = (message: string) => {
    if (stopped) {
      return;
    }
    failures += 1;
    if (failures > 3) {
      onStatus({ state: "failed", message, cacheMissing: false });
      return;
    }
    onStatus({ state: "reconnecting" });
    current = undefined;
    setTimeout(start, failures * 1000);
  };

  async function start() {
    try {
      const { topic } = await getClients();
      const response = await topic.subscribe(CACHE_NAME, TOPIC_NAME, {
        onItem: (item) => onMessage(item.valueString()),
        onError: (error, failed) => {
          failed.unsubscribe();
          retry(error.message());
        },
      });
      if (response.type === TopicSubscribeResponse.Error) {
        if (response.errorCode() === MomentoErrorCode.CACHE_NOT_FOUND_ERROR) {
          onStatus({ state: "failed", message: response.message(), cacheMissing: true });
          return;
        }
        retry(response.message());
        return;
      }
      if (stopped) {
        response.unsubscribe();
        return;
      }
      subscription = response;
      failures = 0;
      onStatus({ state: "subscribed" });
    } catch (error) {
      retry(error instanceof Error ? error.message : String(error));
    }
  }

  onStatus({ state: "connecting" });
  void start();
  return () => {
    stopped = true;
    subscription?.unsubscribe();
  };
}
