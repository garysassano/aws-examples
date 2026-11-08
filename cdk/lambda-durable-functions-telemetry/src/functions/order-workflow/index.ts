import { randomUUID } from "node:crypto";
import {
  type DurableContext,
  StepSemantics,
  createRetryStrategy,
  withDurableExecution,
} from "@aws/durable-execution-sdk-js";
import {
  DynamoDBExporter,
  LambdaLogExporter,
  S3Exporter,
  durableExecutionTelemetry,
} from "@aws/durable-execution-sdk-js-telemetry-exporter";

const { TELEMETRY_TABLE_NAME, TELEMETRY_BUCKET_NAME } = process.env;
if (!TELEMETRY_TABLE_NAME || !TELEMETRY_BUCKET_NAME) {
  throw new Error("Missing TELEMETRY_TABLE_NAME or TELEMETRY_BUCKET_NAME");
}

interface Order {
  orderId: string;
  amount: number;
}

class PaymentError extends Error {
  override name = "PaymentError";
}

// One record per execution when it ends, sent to every exporter in parallel.
// An exporter that fails is logged and skipped; it never fails the execution.
const telemetry = durableExecutionTelemetry({
  exporters: [
    // The function's own log group, for Logs Insights. Needs no permissions.
    new LambdaLogExporter(),
    // One item per record, keyed by execution ARN and emit time, for lookups by execution.
    new DynamoDBExporter({ tableName: TELEMETRY_TABLE_NAME }),
    // One object per execution under year=/month=/day= partitions, for Athena.
    new S3Exporter({ bucket: TELEMETRY_BUCKET_NAME }),
  ],
});

export const handler = withDurableExecution(
  async (order: Order, context: DurableContext) => {
    await context.step("validate-order", async () => {
      if (!order.orderId || !(order.amount > 0)) throw new Error("invalid order");
    });

    // A flaky dependency: each attempt fails 30% of the time, and the SDK retries with backoff.
    // Every attempt is checkpointed, so the record shows how many it took.
    const reservationId = await context.step(
      "reserve-inventory",
      async () => {
        if (Math.random() < 0.3) throw new Error("inventory service timed out");
        return randomUUID();
      },
      {
        retryStrategy: createRetryStrategy({
          maxAttempts: 5,
          initialDelay: { seconds: 1 },
          maxDelay: { seconds: 5 },
        }),
      },
    );

    // The function suspends here and Lambda invokes it again when the wait ends,
    // replaying the steps above from their checkpoints instead of running them again.
    await context.wait("fraud-check-window", { seconds: 10 });

    // Charging is not idempotent, so it runs at most once and a decline fails the execution.
    const chargeId = await context.step(
      "charge-payment",
      async () => {
        if (order.amount > 1000) throw new PaymentError(`card declined for ${order.amount}`);
        return randomUUID();
      },
      {
        semantics: StepSemantics.AtMostOncePerRetry,
        retryStrategy: () => ({ shouldRetry: false }),
      },
    );

    return { orderId: order.orderId, reservationId, chargeId, status: "completed" };
  },
  { plugins: [telemetry] },
);
