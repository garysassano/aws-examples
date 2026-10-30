import { IdempotencyConfig, makeIdempotent } from "@aws-lambda-powertools/idempotency";
import { DynamoDBPersistenceLayer } from "@aws-lambda-powertools/idempotency/dynamodb";
import { Logger } from "@aws-lambda-powertools/logger";
import { injectLambdaContext } from "@aws-lambda-powertools/logger/middleware";
import { parser } from "@aws-lambda-powertools/parser/middleware";
import { S3Schema } from "@aws-lambda-powertools/parser/schemas";
import type { S3Event } from "@aws-lambda-powertools/parser/types";
import {
  DetectLabelsCommand,
  ImageTooLargeException,
  InvalidImageFormatException,
  type Label,
  RekognitionClient,
} from "@aws-sdk/client-rekognition";
import middy from "@middy/core";
import { Hash } from "@smithy/hash-node";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import type { Context } from "aws-lambda";
import { validateEnv } from "../../utils/validate-env.js";

//==============================================================================
// TYPES
//==============================================================================

/** A bounding box as ratios of the image's width and height. */
interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** What the website receives on the `/results/<uploadId>` channel. */
type Result =
  | {
      status: "done";
      isCat: boolean;
      /** The highest confidence among the cat labels, or `null` when there is none. */
      confidence: number | null;
      labels: { name: string; confidence: number }[];
      /** One box per cat that Rekognition located in the image. */
      boxes: Box[];
    }
  | { status: "unsupported" }
  | { status: "error" };

//==============================================================================
// LAMBDA INITIALIZATION (COLD START)
//==============================================================================

const env = validateEnv(["IDEMPOTENCY_TABLE_NAME", "EVENT_API_HTTP_DNS"]);

// Initialize Powertools and AWS SDK clients
const logger = new Logger({ serviceName: "detectLabelsLambda" });
const rekognitionClient = new RekognitionClient();

// Uploads are stored as `uploads/<uploadId>`; the website listens on `/results/<uploadId>`.
const UPLOAD_PREFIX = "uploads/";
const MIN_CONFIDENCE = 75;
const MAX_LABELS_RETURNED = 10;

// Detections are cached by the image's ETag, so uploading the same image again reuses the
// stored result instead of calling Rekognition again.
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
 * Detects the labels in an image with Amazon Rekognition and decides whether it shows a cat.
 *
 * @param image - The S3 object to analyze. Its `eTag` is the idempotency key.
 * @returns The labels, and the cats' bounding boxes, or `unsupported` for a file that is not
 * a JPEG or PNG within Rekognition's limits.
 */
async function detect(image: { bucket: string; key: string; eTag: string }): Promise<Result> {
  try {
    const { Labels = [] } = await rekognitionClient.send(
      new DetectLabelsCommand({
        Image: { S3Object: { Bucket: image.bucket, Name: image.key } },
        MinConfidence: MIN_CONFIDENCE,
      }),
    );

    const cats = Labels.filter(isCatLabel);
    return {
      status: "done",
      isCat: cats.length > 0,
      confidence:
        cats.length > 0 ? Math.max(...cats.map((label) => round(label.Confidence))) : null,
      labels: Labels.slice(0, MAX_LABELS_RETURNED).map((label) => ({
        name: label.Name ?? "",
        confidence: round(label.Confidence),
      })),
      boxes: cats
        .flatMap((label) => label.Instances ?? [])
        .flatMap(({ BoundingBox: box }) =>
          box
            ? [
                {
                  left: box.Left ?? 0,
                  top: box.Top ?? 0,
                  width: box.Width ?? 0,
                  height: box.Height ?? 0,
                },
              ]
            : [],
        ),
    };
  } catch (error) {
    // A file that is not an image would fail on every retry, so report it as a result.
    if (error instanceof InvalidImageFormatException || error instanceof ImageTooLargeException) {
      return { status: "unsupported" };
    }
    throw error;
  }
}

/** Whether a label is "Cat", or a more specific kind of cat such as a breed. */
function isCatLabel(label: Label): boolean {
  return (
    label.Name === "Cat" ||
    label.Aliases?.some((alias) => alias.Name === "Cat") === true ||
    label.Parents?.some((parent) => parent.Name === "Cat") === true
  );
}

function round(confidence: number | undefined): number {
  return Math.round((confidence ?? 0) * 10) / 10;
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
