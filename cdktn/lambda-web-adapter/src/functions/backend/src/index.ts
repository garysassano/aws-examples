import { serve } from "@hono/node-server";
import { Redis } from "@upstash/redis";
import { Hono } from "hono";

// Reads UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN. The REST client
// holds no connection, so nothing breaks while Lambda freezes the environment.
const redis = Redis.fromEnv();

const app = new Hono();

app.get("/", (c) => c.text("Hello from Hono!"));

// Readiness check for the Lambda Web Adapter.
app.get("/ping", (c) => c.text("pong"));

app.get("/api/clicks", async (c) => {
  const clicks = (await redis.get<number>("clicks")) ?? 0;
  return c.json({ clicks });
});

app.post("/api/clicks", async (c) => {
  const clicks = await redis.incr("clicks");
  return c.json({ clicks });
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Internal Server Error" }, 500);
});

serve(app);
