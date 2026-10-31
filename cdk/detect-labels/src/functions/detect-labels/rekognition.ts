import {
  DetectLabelsCommand,
  ImageTooLargeException,
  InvalidImageFormatException,
  type Label,
  RekognitionClient,
} from "@aws-sdk/client-rekognition";
import { type Detection, type Image, createHandler } from "./handler.js";

const rekognitionClient = new RekognitionClient();

const MIN_CONFIDENCE = 75;
const MAX_LABELS_RETURNED = 10;

/**
 * Detects the labels in an image with Amazon Rekognition and decides whether it shows a cat.
 *
 * @returns The labels, and the cats' bounding boxes, or `unsupported` for a file that is not
 * a JPEG or PNG within Rekognition's limits.
 */
async function detect(image: Image, signal: AbortSignal): Promise<Detection> {
  try {
    const { Labels = [] } = await rekognitionClient.send(
      new DetectLabelsCommand({
        Image: { S3Object: { Bucket: image.bucket, Name: image.key } },
        MinConfidence: MIN_CONFIDENCE,
      }),
      { abortSignal: signal },
    );

    const cats = Labels.filter(isCatLabel);
    return {
      status: "done",
      isCat: cats.length > 0,
      confidence:
        cats.length > 0 ? Math.max(...cats.map((label) => round(label.Confidence))) : null,
      // The API doesn't promise an order, so sort before keeping the most confident ones.
      labels: Labels.toSorted((a, b) => (b.Confidence ?? 0) - (a.Confidence ?? 0))
        .slice(0, MAX_LABELS_RETURNED)
        .map((label) => ({ name: label.Name ?? "", confidence: round(label.Confidence) })),
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

export const handler = createHandler(detect, "rekognition");
