import type { IncomingMessage, ServerResponse } from "node:http";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  AuthClient,
  CacheRole,
  CredentialProvider,
  ExpiresIn,
  GenerateDisposableTokenResponse,
  TopicRole,
} from "@gomomento/sdk";
import type { Plugin } from "vite";
import { z } from "zod";
import { CACHE_NAME, TABLE_NAME, TOPIC_NAME } from "../src/shared";

const recordFields = z.object({
  maxTemp: z.number(),
  minTemp: z.number(),
  precipitation: z.number().min(0).max(100),
  ttlSeconds: z.number().int().positive(),
});

/**
 * Serves the page's API from the Vite dev server, so the browser never holds credentials:
 * DynamoDB calls use your default AWS credentials, and the page gets a disposable Momento
 * token that can only read the cache and subscribe to the topic.
 */
export function demoApi(env: Record<string, string>): Plugin {
  return {
    name: "demo-api",
    configureServer(server) {
      const { MOMENTO_API_KEY: apiKey, MOMENTO_ENDPOINT: endpoint } = env;
      if (!apiKey || !endpoint) {
        throw new Error("Set MOMENTO_API_KEY and MOMENTO_ENDPOINT before starting the demo.");
      }

      const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
      let auth: AuthClient | undefined;
      const momentoToken = async () => {
        auth ??= new AuthClient({
          credentialProvider: CredentialProvider.fromApiKeyV2({ apiKey, endpoint }),
        });
        const response = await auth.generateDisposableToken(
          {
            permissions: [
              { role: CacheRole.ReadOnly, cache: CACHE_NAME },
              { role: TopicRole.SubscribeOnly, cache: CACHE_NAME, topic: TOPIC_NAME },
            ],
          },
          ExpiresIn.minutes(30),
        );
        if (response.type === GenerateDisposableTokenResponse.Error) {
          throw new Error(response.message());
        }
        return { token: response.authToken, expiresAt: response.expiresAt.epoch() };
      };

      server.middlewares.use("/api", (req, res) => {
        handle(req, res, dynamodb, momentoToken).catch((error: unknown) => {
          if (error instanceof z.ZodError) {
            send(res, 400, { error: z.prettifyError(error) });
          } else if (error instanceof SyntaxError) {
            send(res, 400, { error: "The request body must be JSON" });
          } else {
            send(res, 500, { error: error instanceof Error ? error.message : String(error) });
          }
        });
      });
    },
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  dynamodb: DynamoDBDocumentClient,
  momentoToken: () => Promise<{ token: string; expiresAt: number }>,
) {
  // Any site open in the browser can send requests to localhost; only this page may use the API.
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin") {
    return send(res, 403, { error: "Cross-site request refused" });
  }

  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  if (pathname === "/momento-token" && req.method === "GET") {
    return send(res, 200, await momentoToken());
  }

  const location = pathname.match(/^\/records\/([^/]+)$/)?.[1];
  if (location === undefined) {
    return send(res, 404, { error: "Not found" });
  }
  const Key = { Location: decodeURIComponent(location) };

  switch (req.method) {
    case "GET": {
      const { Item } = await dynamodb.send(new GetCommand({ TableName: TABLE_NAME, Key }));
      return send(res, 200, Item ?? null);
    }
    case "PUT": {
      const record = recordFields.parse(await readJson(req));
      await dynamodb.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: {
            ...Key,
            MaxTemp: record.maxTemp,
            MinTemp: record.minTemp,
            ChancesOfPrecipitation: record.precipitation,
            // DynamoDB TTL takes an epoch time; the cache put pipe passes TtlSeconds to Momento.
            TTL: Math.floor(Date.now() / 1000) + record.ttlSeconds,
            TtlSeconds: record.ttlSeconds,
          },
        }),
      );
      return send(res, 204);
    }
    case "DELETE": {
      // Deleting a missing record changes nothing, so no event reaches the pipes.
      const { Attributes } = await dynamodb.send(
        new DeleteCommand({ TableName: TABLE_NAME, Key, ReturnValues: "ALL_OLD" }),
      );
      return send(res, 200, { deleted: Attributes !== undefined });
    }
    default:
      return send(res, 405, { error: "Method not allowed" });
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(res: ServerResponse, status: number, body?: unknown) {
  res.statusCode = status;
  if (body === undefined) {
    res.end();
    return;
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}
