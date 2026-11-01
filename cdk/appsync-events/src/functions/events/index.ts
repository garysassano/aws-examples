import { AppSyncEventsResolver } from "@aws-lambda-powertools/event-handler/appsync-events";
import { Logger } from "@aws-lambda-powertools/logger";
import { injectLambdaContext } from "@aws-lambda-powertools/logger/middleware";
import middy from "@middy/core";
import type { Context } from "aws-lambda";

const logger = new Logger({ serviceName: "eventsFunction" });

const app = new AppSyncEventsResolver({ logger });

// Subscribers receive what this returns instead of what was published.
app.onPublish("/lambda/*", (payload, event) => {
  logger.info("Event published", { channel: event.info.channel.path, payload });
  return {
    processed: true,
    originalPayload: payload,
  };
});

app.onSubscribe("/lambda/*", (event) => {
  logger.info("Client subscribed", { channel: event.info.channel.path });
});

export const handler = middy()
  .use(injectLambdaContext(logger))
  .handler((event: unknown, context: Context) => app.resolve(event, context));
