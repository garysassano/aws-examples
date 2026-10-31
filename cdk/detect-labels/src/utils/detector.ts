export const DETECTORS = ["rekognition", "sagemaker"] as const;

export type Detector = (typeof DETECTORS)[number];

// The app deploys the Rekognition detector unless told otherwise, since it needs no Docker and
// deploys in a third of the time. Pass `-c detector=sagemaker` for the open model on SageMaker,
// or `-c detector=all` for both, as two independent stacks.
export function getDetectors(input: unknown): Detector[] {
  if (input === undefined) {
    return ["rekognition"];
  }
  if (input === "all") {
    return [...DETECTORS];
  }

  const detector = DETECTORS.find((name) => name === input);
  if (detector === undefined) {
    throw new Error(`detector must be one of ${[...DETECTORS, "all"].join(", ")}, got "${input}"`);
  }
  return [detector];
}
