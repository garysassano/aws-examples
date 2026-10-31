import { setTimeout } from "node:timers/promises";
import {
  IdempotencyAlreadyInProgressError,
  IdempotencyConfig,
  makeIdempotent,
} from "@aws-lambda-powertools/idempotency";
import { DynamoDBPersistenceLayer } from "@aws-lambda-powertools/idempotency/dynamodb";
import { Logger } from "@aws-lambda-powertools/logger";
import { injectLambdaContext } from "@aws-lambda-powertools/logger/middleware";
import { parser } from "@aws-lambda-powertools/parser/middleware";
import { S3Schema } from "@aws-lambda-powertools/parser/schemas";
import type { S3Event } from "@aws-lambda-powertools/parser/types";
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
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** What a detector finds in one image. */
export type Detection =
  | {
      status: "done";
      isCat: boolean;
      /** The highest confidence among the cats, or `null` when there is none. */
      confidence: number | null;
      /** At most ten labels, the most confident first. */
      labels: { name: string; confidence: number }[];
      /** One box per cat that the detector located in the image. */
      boxes: Box[];
    }
  // A file the detector cannot read as an image.
  | { status: "unsupported" };

/** The S3 object to analyze. Its `eTag` is the idempotency key. */
export interface Image {
  bucket: string;
  key: string;
  eTag: string;
}

/** Detects the labels in an image, giving up when `signal` aborts. */
export type Detect = (image: Image, signal: AbortSignal) => Promise<Detection>;

/** What the website receives on the `/results/<uploadId>` channel. */
type Result = (Detection & { cached?: boolean }) | { status: "error" };

//==============================================================================
// LAMBDA INITIALIZATION (COLD START)
//==============================================================================

const env = validateEnv(["IDEMPOTENCY_TABLE_NAME", "EVENT_API_HTTP_DNS"]);

const logger = new Logger({ serviceName: "detectLabelsLambda" });

// Uploads are stored as `uploads/<uploadId>`; the website listens on `/results/<uploadId>`.
const UPLOAD_PREFIX = "uploads/";
// Time kept back from the function's timeout to publish an error if detection runs out of time.
const PUBLISH_MARGIN_MS = 3_000;
// How long to wait before asking again when another invocation is detecting the same image.
const IN_PROGRESS_RETRY_MS = 1_000;

// Detections are cached by the image's ETag, so uploading the same image again reuses the
// stored result instead of calling the detector again. The website marks such results.
const persistenceStore = new DynamoDBPersistenceLayer({ tableName: env.IDEMPOTENCY_TABLE_NAME });
const idempotencyConfig = new IdempotencyConfig({
  eventKeyJmesPath: "eTag",
  throwOnNoIdempotencyKey: true,
  expiresAfterSeconds: 24 * 60 * 60,
  responseHook: (response) => ({ ...(response as object), cached: true }),
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

/**
 * Creates the detect function's handler around a detector.
 *
 * @param detect - Detects the labels in one image.
 * @param keyPrefix - Prefixes the idempotency keys. It replaces the default prefix, the function
 * and wrapped function names, which minifying can change; include anything that changes the
 * detection, such as the model version, so a new one doesn't reuse old results.
 */
export function createHandler(detect: Detect, keyPrefix: string) {
  const detectOnce = makeIdempotent(detect, {
    persistenceStore,
    config: idempotencyConfig,
    keyPrefix,
  });

  /** Detects once per image, waiting while another invocation is detecting the same one. */
  async function detectBefore(deadline: number, image: Image): Promise<Result> {
    for (;;) {
      try {
        return await detectOnce(image, AbortSignal.timeout(Math.max(deadline - Date.now(), 0)));
      } catch (error) {
        // Two uploads of the same image share one record, and the second one finds it in
        // progress; the first one's result will be stored there soon.
        if (
          !(error instanceof IdempotencyAlreadyInProgressError) ||
          Date.now() + IN_PROGRESS_RETRY_MS >= deadline
        ) {
          throw error;
        }
        logger.info("The same image is being detected by another invocation; waiting");
        await setTimeout(IN_PROGRESS_RETRY_MS);
      }
    }
  }

  const lambdaHandler = async (event: S3Event, context: Context) => {
    idempotencyConfig.registerLambdaContext(context);
    const deadline = Date.now() + context.getRemainingTimeInMillis() - PUBLISH_MARGIN_MS;

    for (const { s3 } of event.Records) {
      const uploadId = s3.object.key.slice(UPLOAD_PREFIX.length);
      logger.appendKeys({ uploadId });

      let result: Result;
      try {
        result = await detectBefore(deadline, {
          bucket: s3.bucket.name,
          key: s3.object.key,
          // Every upload has a unique key, so it stands in if an event has no ETag.
          eTag: s3.object.eTag ?? s3.object.key,
        });
        logger.info("Labels detected", { status: result.status, cached: "cached" in result });
      } catch (error) {
        // The website is waiting for this upload, so tell it instead of leaving it hanging.
        logger.error("Label detection failed", error as Error);
        result = { status: "error" };
      }

      await publish(`/results/${uploadId}`, result);
    }
  };

  return middy(lambdaHandler)
    .use(injectLambdaContext(logger, { resetKeys: true }))
    .use(parser({ schema: S3Schema }));
}

//==============================================================================
// HELPER FUNCTIONS
//==============================================================================

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
