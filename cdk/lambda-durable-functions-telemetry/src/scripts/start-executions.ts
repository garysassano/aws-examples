import { randomUUID } from "node:crypto";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { ALIAS_NAME, FUNCTION_NAME, REGION } from "../constants.js";

const COUNT = Number(process.argv[2] ?? 100);
const CONCURRENCY = 50;

const lambda = new LambdaClient({ region: REGION });

// Amounts above 1,000 are declined, so about one order in five fails.
const orders = Array.from({ length: COUNT }, (_, index) => ({
  orderId: `order-${index + 1}-${randomUUID().slice(0, 8)}`,
  amount: Math.round(10 + Math.random() * 1240),
}));

const started = performance.now();
let next = 0;
const worker = async () => {
  while (next < orders.length) {
    const order = orders[next++];
    await lambda.send(
      new InvokeCommand({
        FunctionName: FUNCTION_NAME,
        Qualifier: ALIAS_NAME,
        // Asynchronous, so each call returns once the execution has started.
        InvocationType: "Event",
        // Names the execution; starting the same name again is a no-op rather than a duplicate.
        DurableExecutionName: order.orderId,
        Payload: JSON.stringify(order),
      }),
    );
  }
};
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, COUNT) }, worker));

const seconds = (performance.now() - started) / 1000;
const declined = orders.filter((order) => order.amount > 1000).length;
console.log(
  `Started ${COUNT} executions in ${seconds.toFixed(1)} s (${(COUNT / seconds).toFixed(0)} per second); ${declined} will be declined.`,
);
console.log("Each takes at least 10 seconds, plus up to about 20 seconds of inventory retries.");
