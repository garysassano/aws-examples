import {
  BedrockRuntimeClient,
  InvokeModelWithResponseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import type { APIGatewayProxyEvent } from "aws-lambda";

const MODEL_ID = "eu.amazon.nova-lite-v1:0";
const bedrockClient = new BedrockRuntimeClient();

interface RequestBody {
  message?: string;
}

export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  // Write HTTP response metadata for API Gateway
  responseStream.write('{"statusCode": 200}');
  responseStream.write("\x00".repeat(8));

  try {
    // Extract message from event (supports both API Gateway and direct invocation)
    const apiEvent = event as APIGatewayProxyEvent;
    const body: RequestBody = apiEvent.body ? JSON.parse(apiEvent.body) : event;
    const message = body.message || "Hello, what can you help me with today?";

    // Prepare request for Nova Lite model
    const requestBody = {
      messages: [
        {
          role: "user",
          content: [
            {
              text: message,
            },
          ],
        },
      ],
      inferenceConfig: {
        max_new_tokens: 4096,
        temperature: 0.7,
      },
    };

    const command = new InvokeModelWithResponseStreamCommand({
      modelId: MODEL_ID,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(requestBody),
    });

    const response = await bedrockClient.send(command);

    // Stream response chunks from Nova Lite
    if (response.body) {
      for await (const chunk of response.body) {
        if (chunk.chunk?.bytes) {
          const chunkData = JSON.parse(new TextDecoder().decode(chunk.chunk.bytes));

          if (chunkData.contentBlockDelta?.delta?.text) {
            responseStream.write(chunkData.contentBlockDelta.delta.text);
          }
        }
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    responseStream.write(`Error: ${errorMessage}`);
  } finally {
    responseStream.end();
  }
});
