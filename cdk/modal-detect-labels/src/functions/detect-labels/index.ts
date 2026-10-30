import { IdempotencyConfig, makeIdempotent } from "@aws-lambda-powertools/idempotency";
import { DynamoDBPersistenceLayer } from "@aws-lambda-powertools/idempotency/dynamodb";
import { Logger } from "@aws-lambda-powertools/logger";
import { injectLambdaContext } from "@aws-lambda-powertools/logger/middleware";
import { getSecret } from "@aws-lambda-powertools/parameters/secrets";
import { parser } from "@aws-lambda-powertools/parser/middleware";
import { S3Schema } from "@aws-lambda-powertools/parser/schemas";
import type { S3Event } from "@aws-lambda-powertools/parser/types";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import middy from "@middy/core";
import { Hash } from "@smithy/hash-node";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import type { Context } from "aws-lambda";
import { z } from "zod";
import { validateEnv } from "../../utils/validate-env.js";

//==============================================================================
// SCHEMAS
//==============================================================================

/** The Modal proxy token that the stack's secret holds. */
const modalTokenSchema = z.object({ key: z.string(), secret: z.string() });

/** What the Modal endpoint returns for an image it could read. */
const resultSchema = z.object({
  status: z.literal("done"),
  isCat: z.boolean(),
  /** The highest confidence among the cat labels, or `null` when there is none. */
  confidence: z.number().nullable(),
  labels: z.array(z.object({ name: z.string(), confidence: z.number() })),
  /** One box per cat that the model located, as ratios of the image's width and height. */
  boxes: z.array(
    z.object({ left: z.number(), top: z.number(), width: z.number(), height: z.number() }),
  ),
});

/** What the website receives on the `/results/<uploadId>` channel. */
type Result = z.infer<typeof resultSchema> | { status: "unsupported" } | { status: "error" };

//==============================================================================
// LAMBDA INITIALIZATION (COLD START)
//==============================================================================

const env = validateEnv([
  "IDEMPOTENCY_TABLE_NAME",
  "EVENT_API_HTTP_DNS",
  "MODAL_ENDPOINT_URL",
  "MODAL_TOKEN_SECRET_NAME",
]);

// Initialize Powertools and AWS SDK clients
const logger = new Logger({ serviceName: "detectLabelsLambda" });
const s3Client = new S3Client();

// Uploads are stored as `uploads/<uploadId>`; the website listens on `/results/<uploadId>`.
const UPLOAD_PREFIX = "uploads/";
const MODAL_TIMEOUT_MS = 45_000;

// Detections are cached by the image's ETag, so uploading the same image again reuses the
// stored result instead of calling Modal again.
const persistenceStore = new DynamoDBPersistenceLayer({ tableName: env.IDEMPOTENCY_TABLE_NAME });
const idempotencyConfig = new IdempotencyConfig({
  eventKeyJmesPath: "eTag",
  throwOnNoIdempotencyKey: true,
  expiresAfterSeconds: 24 * 60 * 60,
});

// AppSync Events accepts IAM-signed publishes over its HTTP endpoint.
const signer = new SignatureV4({
  service: "appsync",
  region: process.env.AWS_REGION as string,
  sha256: Hash.bind(null, "sha256"),
  credentials: async () => ({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID as string,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY as string,
    sessionToken: process.env.AWS_SESSION_TOKEN,
  }),
});

//==============================================================================
// LAMBDA HANDLER
//==============================================================================

const detectOnce = makeIdempotent(detect, { persistenceStore, config: idempotencyConfig });

const lambdaHandler = async (event: S3Event, context: Context) => {
  idempotencyConfig.registerLambdaContext(context);

  await Promise.all(
    event.Records.map(async ({ s3 }) => {
      const channel = `/results/${s3.object.key.slice(UPLOAD_PREFIX.length)}`;

      let result: Result;
      try {
        result = await detectOnce({
          bucket: s3.bucket.name,
          key: s3.object.key,
          // Every upload has a unique key, so it stands in if an event has no ETag.
          eTag: s3.object.eTag ?? s3.object.key,
        });
      } catch (error) {
        // The website is waiting for this upload, so tell it instead of leaving it hanging.
        logger.error("Label detection failed", error as Error);
        result = { status: "error" };
      }

      await publish(channel, result);
    }),
  );
};

export const handler = middy(lambdaHandler)
  .use(injectLambdaContext(logger, { logEvent: true }))
  .use(parser({ schema: S3Schema }));

//==============================================================================
// HELPER FUNCTIONS
//==============================================================================

/**
 * Sends the image to the Modal endpoint, which detects objects with an open model and decides
 * whether it shows a cat.
 *
 * @param image - The S3 object to analyze. Its `eTag` is the idempotency key.
 * @returns The labels, and the cats' bounding boxes, or `unsupported` for a file the model
 * cannot read as an image.
 */
async function detect(image: { bucket: string; key: string; eTag: string }): Promise<Result> {
  const { Body } = await s3Client.send(
    new GetObjectCommand({ Bucket: image.bucket, Key: image.key }),
  );
  if (!Body) throw new Error(`${image.key} has no body`);
  const bytes = await Body.transformToByteArray();

  // The proxy token is `{ key, secret }`; Modal checks both before the request reaches the app.
  // Powertools caches the secret across invocations for a minute by default.
  const token = await getSecret(env.MODAL_TOKEN_SECRET_NAME, { transform: "json" });
  const { key, secret } = modalTokenSchema.parse(token);

  const response = await fetch(env.MODAL_ENDPOINT_URL, {
    method: "POST",
    headers: { "Modal-Key": key, "Modal-Secret": secret },
    body: bytes,
    // The first request after the endpoint has been idle starts a container, which takes ~15 s.
    signal: AbortSignal.timeout(MODAL_TIMEOUT_MS),
  });

  // A file that is not an image would fail on every retry, so report it as a result.
  if (response.status === 415) return { status: "unsupported" };
  if (!response.ok) {
    throw new Error(`Modal responded ${response.status}: ${await response.text()}`);
  }
  return resultSchema.parse(await response.json());
}

/**
 * Publishes a result to an AppSync Events channel, signing the request with the function's role.
 *
 * @param channel - The channel path, such as `/results/<uploadId>`.
 * @param result - The result to send; AppSync Events takes each event as a JSON string.
 */
async function publish(channel: string, result: Result): Promise<void> {
  const body = JSON.stringify({ channel, events: [JSON.stringify(result)] });
  const host = env.EVENT_API_HTTP_DNS;

  const { headers } = await signer.sign(
    new HttpRequest({
      method: "POST",
      protocol: "https:",
      hostname: host,
      path: "/event",
      headers: { host, "content-type": "application/json" },
      body,
    }),
  );
  // fetch sets Host itself, to the same value that was signed.
  const { host: _, ...rest } = headers;

  const response = await fetch(`https://${host}/event`, { method: "POST", headers: rest, body });
  if (!response.ok) {
    throw new Error(`Publishing to ${channel} failed: ${response.status} ${await response.text()}`);
  }
}
