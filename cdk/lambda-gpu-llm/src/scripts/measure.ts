import { setTimeout as sleep } from "node:timers/promises";
import { CloudWatchLogsClient, paginateFilterLogEvents } from "@aws-sdk/client-cloudwatch-logs";
import { DescribeInstancesCommand, EC2Client } from "@aws-sdk/client-ec2";
import {
  GetFunctionConfigurationCommand,
  InvokeCommand,
  LambdaClient,
  TooManyRequestsException,
} from "@aws-sdk/client-lambda";
import { REGION, VARIANTS, type Variant, functionName } from "../constants.js";

const RUNS = Number(process.argv[2] ?? 3);
const POLL_MS = 2_000;
const WAKE_DEADLINE_MS = 20 * 60 * 1000;
const IDLE_DEADLINE_MS = 60 * 60 * 1000;

const ec2 = new EC2Client({ region: REGION });
const lambda = new LambdaClient({ region: REGION, maxAttempts: 1 });
const logs = new CloudWatchLogsClient({ region: REGION });

const seconds = (from: Date, to: Date) => (to.getTime() - from.getTime()) / 1000;

const ask = (maxTokens: number) =>
  JSON.stringify({
    messages: [{ role: "user", content: "Write a short story about a lighthouse keeper." }],
    max_tokens: maxTokens,
    // A fixed length, so warm throughput compares across runs
    ignore_eos: true,
    chat_template_kwargs: { enable_thinking: false },
  });

async function invoke(FunctionName: string, maxTokens: number) {
  const response = await lambda.send(new InvokeCommand({ FunctionName, Payload: ask(maxTokens) }));
  const body = new TextDecoder().decode(response.Payload);
  if (response.FunctionError) throw new Error(`${FunctionName}: ${body}`);
  return JSON.parse(body) as { usage?: { completion_tokens?: number } };
}

async function capacityProviderArn(FunctionName: string) {
  const { CapacityProviderConfig } = await lambda.send(
    new GetFunctionConfigurationCommand({ FunctionName }),
  );
  return CapacityProviderConfig?.LambdaManagedInstancesCapacityProviderConfig?.CapacityProviderArn;
}

async function countInstances(arn: string) {
  const { Reservations } = await ec2.send(
    new DescribeInstancesCommand({
      // Hidden from the default listing, as Lambda owns them
      IncludeManagedResources: true,
      Filters: [
        { Name: "tag:aws:lambda:capacity-provider", Values: [arn] },
        { Name: "instance-state-name", Values: ["pending", "running", "stopping"] },
      ],
    }),
  );
  return Reservations?.flatMap(({ Instances }) => Instances ?? []).length ?? 0;
}

/** Lambda's own system log events for the capacity provider, oldest first. */
async function systemLog(FunctionName: string, since: Date) {
  const events: { at: Date; message: string }[] = [];
  const pages = paginateFilterLogEvents(
    { client: logs },
    { logGroupName: `/aws/lambda/capacity-provider/${FunctionName}`, startTime: since.getTime() },
  );
  for await (const page of pages) {
    for (const { message } of page.events ?? []) {
      const event = JSON.parse(message ?? "{}");
      events.push({ at: new Date(event.timestamp), message: event.message });
    }
  }
  return events.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** System log events arrive a little after they happen, so wait for the last one needed. */
async function waitForSystemLog(FunctionName: string, since: Date, last: string) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const events = await systemLog(FunctionName, since);
    if (events.some(({ message }) => message.startsWith(last))) return events;
    await sleep(5_000);
  }
  throw new Error(`${FunctionName}: no "${last}" in the system log`);
}

const firstAt = (events: { at: Date; message: string }[], prefix: string) => {
  const event = events.find(({ message }) => message.startsWith(prefix));
  if (!event) throw new Error(`No "${prefix}" in the system log`);
  return event.at;
};

/** Seconds from the last request until Lambda stopped the environment and the instance. */
interface Idle {
  environment: number;
  instance: number;
}

async function waitForZero(FunctionName: string, lastServedAt: Date): Promise<Idle> {
  const arn = (await capacityProviderArn(FunctionName)) ?? "";
  const deadline = Date.now() + IDLE_DEADLINE_MS;
  // Already at zero, as when the function idled before the script started: nothing to time
  if ((await countInstances(arn)) === 0) return { environment: Number.NaN, instance: Number.NaN };
  while ((await countInstances(arn)) > 0) {
    if (Date.now() > deadline) throw new Error(`${FunctionName} didn't scale to zero`);
    await sleep(30_000);
  }
  const events = await waitForSystemLog(FunctionName, lastServedAt, "Terminated i-");
  return {
    environment: seconds(lastServedAt, firstAt(events, "Execution environment terminated.")),
    instance: seconds(lastServedAt, firstAt(events, "Terminated i-")),
  };
}

/**
 * One wake-up from zero in seconds. The phases follow each other, so they add up to `ready`, from
 * the first request to its first answer.
 */
interface Wake {
  /** From the first throttled request to Lambda asking for an instance. */
  request: number;
  /** Launching the instance. */
  instance: number;
  /** From the launched instance to Lambda creating the execution environment. */
  schedule: number;
  /** Pulling the image, starting vLLM, and loading the model. */
  environment: number;
  /** From the environment being ready to a retried request being answered. */
  answer: number;
  ready: number;
  /** Throughput of a warm request with a fixed number of output tokens. */
  tokensPerSecond: number;
}

async function wake(FunctionName: string): Promise<{ wake: Wake; servedAt: Date }> {
  const startedAt = new Date();
  const deadline = startedAt.getTime() + WAKE_DEADLINE_MS;
  while (true) {
    try {
      await invoke(FunctionName, 16);
      break;
    } catch (error) {
      // Lambda throttles while it starts an execution environment from zero
      if (!(error instanceof TooManyRequestsException)) throw error;
      if (Date.now() > deadline) throw new Error(`${FunctionName} didn't wake up`);
      await sleep(POLL_MS);
    }
  }
  const answeredAt = new Date();

  const warmStart = Date.now();
  const warm = await invoke(FunctionName, 256);
  const tokensPerSecond = (warm.usage?.completion_tokens ?? 0) / ((Date.now() - warmStart) / 1000);
  const servedAt = new Date();

  const events = await waitForSystemLog(FunctionName, startedAt, "Execution environment created.");
  const requested = firstAt(events, "No available capacity");
  const launched = firstAt(events, "Launched ");
  const creating = firstAt(events, "Execution environment is being created.");
  const created = firstAt(events, "Execution environment created.");
  return {
    wake: {
      request: seconds(startedAt, requested),
      instance: seconds(requested, launched),
      schedule: seconds(launched, creating),
      environment: seconds(creating, created),
      answer: seconds(created, answeredAt),
      ready: seconds(startedAt, answeredAt),
      tokensPerSecond,
    },
    servedAt,
  };
}

// The median run rather than per-phase medians, so the phases still add up to `ready`.
function summarize(variant: Variant, wakes: Wake[], idles: Idle[]) {
  const byReady = wakes.toSorted((a, b) => a.ready - b.ready);
  const run = byReady[(byReady.length - 1) >> 1];
  const row: Record<string, string> = { variant };
  for (const [phase, value] of Object.entries(run)) row[phase] = value.toFixed(1);
  row.range = `${byReady[0].ready.toFixed(1)}-${byReady.at(-1)?.ready.toFixed(1)}`;
  const idle = idles.map(({ environment }) => environment).sort((a, b) => a - b);
  row.idle = idle.length ? `${idle[0].toFixed(0)}-${idle.at(-1)?.toFixed(0)}` : "-";
  return row;
}

// Each variant has its own capacity provider, so they run side by side. Every run first waits for
// the function to scale to zero by itself, then wakes it with a request.
const deployed = await Promise.all(
  VARIANTS.map((variant) =>
    capacityProviderArn(functionName(variant)).then(
      () => variant,
      () => undefined,
    ),
  ),
);
const variants = deployed.filter((variant) => variant !== undefined);
console.log(`Measuring ${variants.join(", ")}`);

const rows = await Promise.all(
  variants.map(async (variant) => {
    const name = functionName(variant);
    const wakes: Wake[] = [];
    const idles: Idle[] = [];
    let lastServedAt = new Date();
    for (let run = 1; run <= RUNS; run++) {
      const idle = await waitForZero(name, lastServedAt);
      // The first wait starts from the deployment, not from a request
      if (run > 1) idles.push(idle);
      const { wake: sample, servedAt } = await wake(name);
      // Kept in the output so other summaries can be computed later
      console.log(JSON.stringify({ variant, run, ...sample, idleBefore: run > 1 ? idle : null }));
      wakes.push(sample);
      lastServedAt = servedAt;
    }
    idles.push(await waitForZero(name, lastServedAt));
    console.log(JSON.stringify({ variant, idleAfter: idles.at(-1) }));
    return summarize(variant, wakes, idles);
  }),
);

console.log(`Seconds, from the median run of ${RUNS}, with the range of ready and idle`);
console.table(rows);
