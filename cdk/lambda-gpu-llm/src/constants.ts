export const REGION = "eu-central-1";
export const IMAGE_STACK = "cdk-lambda-gpu-llm-image-dev";
export const IMAGE_BUILDER_PROJECT = "lambda-gpu-llm-image-builder";
export const RESOURCE_PREFIX = "lambda-gpu-llm";

/** Fits an L4's 24 GB with room for the KV cache, and L4 GPUs run FP8 natively. */
export const MODEL_ID = "Qwen/Qwen3-8B-FP8";
/** Lambda's vLLM image; `cuda-v1` is the 1.x release line. */
export const BASE_IMAGE = "public.ecr.aws/lambda/deep-learning-containers/vllm:cuda-v1";

/** The base image as published, for variants that fetch the weights when they start. */
export const BASE_TAG = "base";
/** The base image with the weights in it. */
export const MODEL_TAG = "model";
/** Where the model tag holds the weights, and where the S3 bucket holds them. */
export const MODEL_PATH = "/opt/model";
export const MODEL_PREFIX = "models/qwen3-8b-fp8/";

/** Every variant serves the same model; only where its weights come from differs. */
export const VARIANTS = ["hub", "s3", "baked"] as const;
export type Variant = (typeof VARIANTS)[number];

export const functionName = (variant: Variant) => `${RESOURCE_PREFIX}-${variant}`;
export const variantStack = (variant: Variant) => `cdk-lambda-gpu-llm-${variant}-dev`;
