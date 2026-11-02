import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  type ConverseStreamOutput,
} from "@aws-sdk/client-bedrock-runtime";
import type { APIGatewayProxyEvent } from "aws-lambda";
import { z } from "zod";

//==============================================================================
// LAMBDA INITIALIZATION (COLD START)
//==============================================================================

const { MODEL_ID } = z.object({ MODEL_ID: z.string().min(1) }).parse(process.env);
const bedrockClient = new BedrockRuntimeClient();

// Strict, so a request with unexpected fields is rejected instead of silently ignored.
const requestSchema = z.strictObject({
  message: z.string().trim().min(1).max(10_000),
});

//==============================================================================
// LAMBDA HANDLER
//==============================================================================

export const handler = awslambda.streamifyResponse<APIGatewayProxyEvent>(
  async (event, responseStream) => {
    const request = requestSchema.safeParse(parseJson(event.body));
    if (!request.success) {
      return respond(responseStream, 400, { message: z.prettifyError(request.error) });
    }

    // Errors such as throttling or a missing model surface here, before the status is sent, so the
    // client still receives a real error status rather than a 200 with a broken body.
    let stream: AsyncIterable<ConverseStreamOutput>;
    try {
      const response = await bedrockClient.send(
        new ConverseStreamCommand({
          modelId: MODEL_ID,
          messages: [{ role: "user", content: [{ text: request.data.message }] }],
          inferenceConfig: { maxTokens: 4096 },
        }),
      );
      if (!response.stream) throw new Error("ConverseStream returned no stream");
      stream = response.stream;
    } catch (error) {
      console.error("ConverseStream failed", { error });
      const status = error instanceof Error && error.name === "ThrottlingException" ? 429 : 502;
      return respond(responseStream, status, { message: "The model request failed" });
    }

    // HttpResponseStream writes the metadata and the 8-byte delimiter that API Gateway expects
    // before the payload, and pipeline() respects backpressure from the client.
    await pipeline(
      Readable.from(textDeltas(stream)),
      awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
    );
  },
);

/** Yields the text of each content block delta, skipping metadata and other events. */
async function* textDeltas(stream: AsyncIterable<ConverseStreamOutput>) {
  for await (const event of stream) {
    const text = event.contentBlockDelta?.delta?.text;
    if (text) yield text;
  }
}

function parseJson(body: string | null): unknown {
  try {
    return JSON.parse(body ?? "");
  } catch {
    return undefined;
  }
}

async function respond(
  responseStream: awslambda.HttpResponseStream,
  statusCode: number,
  body: Record<string, unknown>,
) {
  const stream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode,
    headers: { "Content-Type": "application/json" },
  });
  await pipeline(Readable.from([JSON.stringify(body)]), stream);
}
