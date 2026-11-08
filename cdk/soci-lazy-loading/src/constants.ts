export const REGION = "eu-central-1";
export const COMPUTE_STACK = "cdk-soci-lazy-loading-compute-dev";
export const IMAGE_BUILDER_PROJECT = "soci-lazy-loading-image-builder";
export const RESOURCE_PREFIX = "soci-lazy-loading";

export const PLAIN_TAG = "plain";
export const SOCI_TAG = "soci";

// Every variant is the same image and workload; only the tag and LOAD_AT change.
export const VARIANTS = [
  { name: "plain-init", tag: PLAIN_TAG, loadAt: "init" },
  { name: "soci-init", tag: SOCI_TAG, loadAt: "init" },
  { name: "plain-handler", tag: PLAIN_TAG, loadAt: "handler" },
  { name: "soci-handler", tag: SOCI_TAG, loadAt: "handler" },
] as const;
