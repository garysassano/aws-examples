import { setTimeout as sleep } from "node:timers/promises";
import { InvokeCommand, LambdaClient, TooManyRequestsException } from "@aws-sdk/client-lambda";
import { REGION, VARIANTS, type Variant, functionName } from "../constants.js";

const [variantArg = "s3", ...words] = process.argv.slice(2);
if (!VARIANTS.includes(variantArg as Variant)) {
  throw new Error(`Usage: pnpm chat <${VARIANTS.join("|")}> [prompt]`);
}
const FunctionName = functionName(variantArg as Variant);
const prompt = words.join(" ") || "In two sentences, what is a GPU good for?";

// The SDK's own retries give up long before an execution environment is ready
const lambda = new LambdaClient({ region: REGION, maxAttempts: 1 });
const RETRY_INTERVAL_MS = 10_000;
const DEADLINE_MS = 15 * 60 * 1000;

const payload = JSON.stringify({
  messages: [{ role: "user", content: prompt }],
  max_tokens: 512,
  // Qwen3 reasons before answering unless told not to
  chat_template_kwargs: { enable_thinking: false },
});

const startedAt = Date.now();
const elapsed = () => ((Date.now() - startedAt) / 1000).toFixed(1);

while (true) {
  const requestedAt = Date.now();
  try {
    const response = await lambda.send(new InvokeCommand({ FunctionName, Payload: payload }));
    const body = new TextDecoder().decode(response.Payload);
    if (response.FunctionError) throw new Error(body);

    const completion = JSON.parse(body);
    const seconds = (Date.now() - requestedAt) / 1000;
    const tokens = completion.usage?.completion_tokens ?? 0;
    console.log(completion.choices?.[0]?.message?.content);
    console.log(
      `\n${tokens} tokens in ${seconds.toFixed(1)} s (${(tokens / seconds).toFixed(1)}/s), ${elapsed()} s after the first attempt`,
    );
    break;
  } catch (error) {
    // Lambda throttles while it starts an execution environment from zero
    if (!(error instanceof TooManyRequestsException)) throw error;
    if (Date.now() - startedAt > DEADLINE_MS) throw new Error(`${FunctionName} didn't wake up`);
    console.log(`${elapsed()} s: ${FunctionName} is scaling up from zero (${error.Reason})`);
    await sleep(RETRY_INTERVAL_MS);
  }
}
