import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { timing, wrapTime } from "hono/timing";

const TableName = process.env.TABLE_NAME;
if (!TableName) throw new Error("TABLE_NAME is required");

// The count lives in one item, which the first increment creates.
const Key = { id: { S: "clicks" } };
const dynamodb = new DynamoDBClient();

const app = new Hono();

app.get("/", (c) => c.text("Hello from Hono!"));

// Reports each DynamoDB call's duration in a `Server-Timing: dynamodb;dur=…` header,
// which the frontend reads to time the Hono → DynamoDB hop.
app.use("/api/*", timing({ total: false }));

app.get("/api/clicks", async (c) => {
  const { Item } = await wrapTime(
    c,
    "dynamodb",
    dynamodb.send(new GetItemCommand({ TableName, Key, ConsistentRead: true })),
  );
  return c.json({ clicks: Number(Item?.clicks?.N ?? 0) });
});

app.post("/api/clicks", async (c) => {
  // ADD increments atomically, so concurrent clicks are never lost.
  const { Attributes } = await wrapTime(
    c,
    "dynamodb",
    dynamodb.send(
      new UpdateItemCommand({
        TableName,
        Key,
        UpdateExpression: "ADD clicks :one",
        ExpressionAttributeValues: { ":one": { N: "1" } },
        ReturnValues: "UPDATED_NEW",
      }),
    ),
  );
  return c.json({ clicks: Number(Attributes?.clicks?.N) });
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Internal Server Error" }, 500);
});

// Lambda sets the address to listen on; the fallback is for local runs.
const [hostname, port] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT ?? "localhost:3000").split(":");
serve({ fetch: app.fetch, hostname, port: Number(port) });
