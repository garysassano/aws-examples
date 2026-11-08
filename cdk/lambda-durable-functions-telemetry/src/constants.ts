export const REGION = "eu-central-1";
export const STACK_NAME = "cdk-lambda-durable-functions-telemetry-dev";

export const FUNCTION_NAME = "durable-order-workflow";
// Durable functions only accept qualified invocations; the alias pins each execution to a version.
export const ALIAS_NAME = "live";

export const TELEMETRY_TABLE_NAME = "durable-order-telemetry";
export const GLUE_DATABASE_NAME = "durable_order_telemetry";
export const GLUE_TABLE_NAME = "durable_execution_telemetry";
export const ATHENA_WORKGROUP_NAME = "durable-order-telemetry";
// The S3 exporter's default prefix, which the Glue table reads.
export const TELEMETRY_PREFIX = "durable-execution-telemetry/";
