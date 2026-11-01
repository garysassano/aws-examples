import { styleText } from "node:util";
import {
  AppSyncClient,
  GetApiCommand,
  ListApiKeysCommand,
  paginateListApis,
} from "@aws-sdk/client-appsync";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

// Names the CDK stack gives these resources.
const API_NAME = "events-api";
const TABLE_NAME = "events-table";
const NAMESPACES = ["lambda", "dynamodb"];

const CHANNEL = "demo";
const WAIT_SECONDS = 10;

const log = {
  step: (message: string) => console.log(`\n${styleText("blue", "→")} ${message}`),
  success: (message: string) => console.log(`${styleText("green", "✔")} ${message}`),
  data: (label: string, value: unknown) => {
    console.log(styleText("cyan", label));
    console.dir(value, { depth: null, colors: true });
  },
};

/** Finds the deployed API's endpoints and its API key. */
async function findApi() {
  const appsync = new AppSyncClient({});
  for await (const page of paginateListApis({ client: appsync }, {})) {
    const apiId = page.apis?.find(({ name }) => name === API_NAME)?.apiId;
    if (apiId) {
      const [{ api }, { apiKeys }] = await Promise.all([
        appsync.send(new GetApiCommand({ apiId })),
        appsync.send(new ListApiKeysCommand({ apiId })),
      ]);
      const httpDns = api?.dns?.HTTP;
      const realtimeDns = api?.dns?.REALTIME;
      const apiKey = apiKeys?.[0]?.id;
      if (httpDns && realtimeDns && apiKey) {
        return { httpDns, realtimeDns, apiKey };
      }
    }
  }
  throw new Error(`Found no API named ${API_NAME} with an API key. Deploy the stack first.`);
}

/** Opens the WebSocket, subscribes to every namespace, and logs the events it receives. */
function subscribe(realtimeDns: string, auth: Record<string, string>) {
  const header = Buffer.from(JSON.stringify(auth)).toString("base64url");
  const socket = new WebSocket(`wss://${realtimeDns}/event/realtime`, [
    "aws-appsync-event-ws",
    `header-${header}`,
  ]);
  const subscribed = Promise.withResolvers<void>();
  const received = Promise.withResolvers<void>();
  let pendingSubscriptions = NAMESPACES.length;
  let pendingEvents = NAMESPACES.length;

  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ type: "connection_init" }));
  });
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    switch (message.type) {
      case "connection_ack":
        for (const namespace of NAMESPACES) {
          const channel = `/${namespace}/*`;
          socket.send(
            JSON.stringify({ type: "subscribe", id: namespace, channel, authorization: auth }),
          );
        }
        break;
      case "subscribe_success":
        log.success(`Subscribed to /${message.id}/*`);
        if (--pendingSubscriptions === 0) subscribed.resolve();
        break;
      case "data":
        log.data(`Received on /${message.id}/*`, JSON.parse(message.event));
        if (--pendingEvents === 0) received.resolve();
        break;
      case "connection_error":
      case "subscribe_error":
      case "error":
        subscribed.reject(new Error(JSON.stringify(message)));
        received.reject(new Error(JSON.stringify(message)));
        break;
    }
  });
  socket.addEventListener("error", () => {
    subscribed.reject(new Error("The WebSocket connection failed."));
  });

  return { subscribed: subscribed.promise, received: received.promise };
}

/** Publishes one event over HTTP and returns the ID that AppSync gave it. */
async function publish(httpDns: string, apiKey: string, channel: string, event: unknown) {
  const response = await fetch(`https://${httpDns}/event`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ channel, events: [JSON.stringify(event)] }),
  });
  const body = (await response.json()) as { successful?: { identifier: string }[] };
  const id = body.successful?.[0]?.identifier;
  if (!response.ok || !id) {
    throw new Error(`Publishing to ${channel} failed: ${JSON.stringify(body)}`);
  }
  log.success(`Published to ${channel}`);
  return id;
}

const { httpDns, realtimeDns, apiKey } = await findApi();

log.step("Subscribing over WebSocket");
const { subscribed, received } = subscribe(realtimeDns, {
  host: httpDns,
  "x-api-key": apiKey,
});
await subscribed;

log.step("Publishing over HTTP");
const event = { message: "Hello from the demo" };
log.data("Event", event);
const [, storedId] = await Promise.all(
  NAMESPACES.map((namespace) => publish(httpDns, apiKey, `/${namespace}/${CHANNEL}`, event)),
);

await Promise.race([
  received,
  new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error(`Received too few events in ${WAIT_SECONDS} seconds.`)),
      WAIT_SECONDS * 1000,
    ).unref(),
  ),
]);

log.step(`Reading the published event back from ${TABLE_NAME}`);
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const { Item } = await dynamodb.send(
  new GetCommand({ TableName: TABLE_NAME, Key: { id: storedId }, ConsistentRead: true }),
);
log.data("Item", Item);

// The open WebSocket would otherwise keep the process running.
process.exit(0);
