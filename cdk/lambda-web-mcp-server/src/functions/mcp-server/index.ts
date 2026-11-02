import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setImmediate } from "node:timers/promises";
import { localhostHostValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

// Lambda sets the address to listen on. Without it, the server runs locally and listens on
// loopback only, behind the SDK's guard against DNS rebinding.
const lambdaEndpoint = process.env.AWS_LAMBDA_HTTP_ENDPOINT;
const [hostname, port] = (lambdaEndpoint ?? "127.0.0.1:3000").split(":");
const validateHost = lambdaEndpoint ? () => true : localhostHostValidation();

// One execution environment serves many requests at once, so these describe the environment,
// not a request.
const environment = {
  id: randomUUID().slice(0, 8),
  startedAt: new Date(),
  requests: 0,
  inFlight: 0,
};

const MAX_LIMIT = 100_000_000;
// Counting yields to the event loop after each slice, so one long call doesn't stall the other
// requests that share the environment, and progress and cancellation get through.
const SLICE_MS = 50;

function isPrime(n: number): boolean {
  if (n < 4) return n > 1;
  if (n % 2 === 0 || n % 3 === 0) return false;
  for (let i = 5; i * i <= n; i += 6) {
    if (n % i === 0 || n % (i + 2) === 0) return false;
  }
  return true;
}

function jsonResult<T extends Record<string, unknown>>(result: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

// The handler builds a new server for each request, which keeps concurrent requests apart.
function buildServer(): McpServer {
  const server = new McpServer({ name: "lambda-web-mcp-server", version: "1.0.0" });

  server.registerTool(
    "get_environment",
    {
      title: "Get environment",
      description:
        "Describe the Lambda execution environment that served this call: its ID, Region, age, " +
        "how many MCP requests it has served, and how many are in flight right now.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      jsonResult({
        environmentId: environment.id,
        region: process.env.AWS_REGION ?? "local",
        uptimeSeconds: Math.round((Date.now() - environment.startedAt.getTime()) / 1000),
        requestsServed: environment.requests,
        requestsInFlight: environment.inFlight,
      }),
  );

  server.registerTool(
    "count_primes",
    {
      title: "Count primes",
      description:
        "Count the prime numbers up to a limit by trial division. This is deliberately CPU-bound, " +
        "reports progress as it goes, and stops when the call is cancelled.",
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(2)
          .max(MAX_LIMIT)
          .default(20_000_000)
          .describe(`Count primes from 2 up to and including this number (at most ${MAX_LIMIT}).`),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit }, ctx) => {
      const progressToken = ctx.mcpReq._meta?.progressToken;
      const start = performance.now();
      let primes = 0;
      let n = 2;
      let lastPercent = 0;

      while (n <= limit) {
        const sliceEnd = performance.now() + SLICE_MS;
        while (n <= limit && performance.now() < sliceEnd) {
          // Check the clock every 10,000 numbers rather than on each one.
          const batchEnd = Math.min(limit, n + 9_999);
          for (; n <= batchEnd; n++) if (isPrime(n)) primes++;
        }
        await setImmediate();
        if (ctx.mcpReq.signal.aborted) {
          return { isError: true, content: [{ type: "text" as const, text: "Cancelled" }] };
        }

        // Report each new 10% only, so a big limit doesn't flood the client.
        const percent = Math.floor(((n - 1) / limit) * 10) * 10;
        if (progressToken !== undefined && percent > lastPercent && n <= limit) {
          lastPercent = percent;
          await ctx.mcpReq.notify({
            method: "notifications/progress",
            params: {
              progressToken,
              progress: n - 1,
              total: limit,
              message: `${percent}%: ${primes.toLocaleString("en-US")} primes so far`,
            },
          });
        }
      }

      return jsonResult({
        limit,
        primes,
        elapsedMs: Math.round(performance.now() - start),
        environmentId: environment.id,
      });
    },
  );

  return server;
}

const handleMcp = toNodeHandler(createMcpHandler(buildServer));

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  if (pathname !== "/mcp") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }
  if (!validateHost(req, res)) return;

  environment.requests++;
  environment.inFlight++;
  res.on("close", () => environment.inFlight--);
  handleMcp(req, res).catch((error: unknown) => {
    console.error("MCP request failed", error);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});

server.listen(Number(port), hostname, () => {
  console.log(`MCP server listening on http://${hostname}:${port}/mcp`);
});
