import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { serve } from "@hono/node-server";
import { Redis } from "@upstash/redis";
import { Hono } from "hono";
import { timing, wrapTime } from "hono/timing";

/**
 * The Upstash REST token is a secret, so it lives in an SSM SecureString rather than
 * in the function's configuration; the name of the parameter is all Lambda passes.
 */
async function restToken(): Promise<string> {
  const name = process.env.UPSTASH_REDIS_REST_TOKEN_PARAMETER;
  if (!name) throw new Error("UPSTASH_REDIS_REST_TOKEN_PARAMETER is required");
  const { Parameter } = await new SSMClient().send(
    new GetParameterCommand({ Name: name, WithDecryption: true }),
  );
  if (!Parameter?.Value) throw new Error(`Parameter ${name} has no value`);
  return Parameter.Value;
}

const url = process.env.UPSTASH_REDIS_REST_URL;
if (!url) throw new Error("UPSTASH_REDIS_REST_URL is required");

// Read once at startup, before the server listens: Lambda routes requests to an
// environment as soon as its port accepts connections, so Redis is usable by then.
const redis = new Redis({ url, token: await restToken() });

const app = new Hono();

app.get("/", (c) => c.text("Hello from Hono!"));

// Reports each Redis call's duration in a `Server-Timing: redis;dur=…` header,
// which the frontend reads to time the Hono → Redis hop.
app.use("/api/*", timing({ total: false }));

app.get("/api/clicks", async (c) => {
  const clicks = (await wrapTime(c, "redis", redis.get<number>("clicks"))) ?? 0;
  return c.json({ clicks });
});

app.post("/api/clicks", async (c) => {
  const clicks = await wrapTime(c, "redis", redis.incr("clicks"));
  return c.json({ clicks });
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Internal Server Error" }, 500);
});

// Lambda sets the address to listen on; the fallback is for local runs.
const [hostname, port] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT ?? "localhost:3000").split(":");
serve({ fetch: app.fetch, hostname, port: Number(port) });
