import { setTimeout } from "node:timers/promises";
import { Router } from "@aws-lambda-powertools/event-handler/http";
import { Logger } from "@aws-lambda-powertools/logger";
import type { Context } from "aws-lambda";

// Upper bound for the simulated work, since the Function URL is public
const MAX_DELAY_MS = 1000;

const logger = new Logger();
const app = new Router({ logger });

// Fixed for the lifetime of the execution environment: `provisioned-concurrency` or `on-demand`
const initializationType = process.env.AWS_LAMBDA_INITIALIZATION_TYPE;
logger.appendPersistentKeys({ initialization_type: initializationType });

// `?delay=<ms>` keeps each request in flight longer, so a load test can drive concurrency up
app.get("/", async ({ req }) => {
  const requested = Number(new URL(req.url).searchParams.get("delay"));
  const delay = Number.isFinite(requested) ? Math.min(Math.max(requested, 0), MAX_DELAY_MS) : 0;
  await setTimeout(delay);

  // Powertools reports `cold_start: true` only for on-demand environments, so it flags spillover
  logger.info("Request served", { delay });
  return { initializationType, delay };
});

export const handler = async (event: unknown, context: Context) => {
  logger.addContext(context);
  return app.resolve(event, context);
};
