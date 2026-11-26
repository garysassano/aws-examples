import { VARIANTS, type Variant } from "../constants.js";

// The app deploys the S3 variant unless told otherwise. Pass `-c variant=hub` or
// `-c variant=baked` for another one, or `-c variant=all` for all three, as independent stacks.
export function getVariants(input: unknown): Variant[] {
  if (input === undefined) {
    return ["s3"];
  }
  if (input === "all") {
    return [...VARIANTS];
  }

  const variant = VARIANTS.find((name) => name === input);
  if (variant === undefined) {
    throw new Error(`variant must be one of ${[...VARIANTS, "all"].join(", ")}, got "${input}"`);
  }
  return [variant];
}
