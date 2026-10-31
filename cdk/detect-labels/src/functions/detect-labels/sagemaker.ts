import { InvokeEndpointCommand, SageMakerRuntimeClient } from "@aws-sdk/client-sagemaker-runtime";
import { z } from "zod";
import { validateEnv } from "../../utils/validate-env.js";
import { type Detection, type Image, createHandler } from "./handler.js";

const env = validateEnv(["ENDPOINT_NAME", "MODEL_VERSION"]);

const sageMakerClient = new SageMakerRuntimeClient();

/** What the model container returns. */
const detectionSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("done"),
    isCat: z.boolean(),
    confidence: z.number().nullable(),
    labels: z.array(z.object({ name: z.string(), confidence: z.number() })),
    boxes: z.array(
      z.object({ left: z.number(), top: z.number(), width: z.number(), height: z.number() }),
    ),
  }),
  z.object({ status: z.literal("unsupported") }),
]) satisfies z.ZodType<Detection>;

/**
 * Asks the SageMaker Serverless Inference endpoint to detect the objects in an image.
 *
 * The request names the S3 object instead of carrying its bytes, because serverless endpoints
 * accept at most 4 MB and uploads can be 15 MB; the model container reads the image itself.
 *
 * @returns The labels, and the cats' bounding boxes, or `unsupported` for a file the model
 * cannot read as an image.
 */
async function detect(image: Image, signal: AbortSignal): Promise<Detection> {
  const { Body } = await sageMakerClient.send(
    new InvokeEndpointCommand({
      EndpointName: env.ENDPOINT_NAME,
      ContentType: "application/json",
      Accept: "application/json",
      Body: JSON.stringify({ bucket: image.bucket, key: image.key }),
    }),
    { abortSignal: signal },
  );
  return detectionSchema.parse(JSON.parse(new TextDecoder().decode(Body)));
}

export const handler = createHandler(detect, `sagemaker-${env.MODEL_VERSION}`);
