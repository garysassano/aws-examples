import { serve } from "@hono/node-server";
import { Redis } from "@upstash/redis";
import { Hono } from "hono";
import { timing, wrapTime } from "hono/timing";

// Reads UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN. The REST client
// holds no connection, so nothing breaks while Lambda freezes the environment.
const redis = Redis.fromEnv();

const app = new Hono();

app.get("/", (c) => c.text("Hello from Hono!"));

// Readiness check for the Lambda Web Adapter.
app.get("/ping", (c) => c.text("pong"));

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

serve(app);
