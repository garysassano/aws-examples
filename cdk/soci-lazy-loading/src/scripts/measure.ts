import { setTimeout as sleep } from "node:timers/promises";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import {
  CloudWatchLogsClient,
  GetLogEventsCommand,
  paginateFilterLogEvents,
} from "@aws-sdk/client-cloudwatch-logs";
import { DescribeInstancesCommand, EC2Client } from "@aws-sdk/client-ec2";
import {
  DescribeTaskDefinitionCommand,
  DescribeTasksCommand,
  ECSClient,
  RunTaskCommand,
  waitUntilTasksStopped,
} from "@aws-sdk/client-ecs";
import {
  GetFunctionConfigurationCommand,
  InvokeCommand,
  LambdaClient,
  PutFunctionScalingConfigCommand,
} from "@aws-sdk/client-lambda";
import { COMPUTE_STACK, REGION, RESOURCE_PREFIX, VARIANTS } from "../constants.js";

const LATEST_PUBLISHED = "$LATEST.PUBLISHED";
const RUNS = Number(process.argv[2] ?? 3);
const INVOKE_DEADLINE_MS = 10 * 60 * 1000;

const cloudformation = new CloudFormationClient({ region: REGION });
const ec2 = new EC2Client({ region: REGION });
const ecs = new ECSClient({ region: REGION });
const lambda = new LambdaClient({ region: REGION, maxAttempts: 1 });
const logs = new CloudWatchLogsClient({ region: REGION });

/** What app.py returns. */
interface WorkloadResult {
  startedAt: number;
  loadSeconds: number;
  requestSeconds: number;
  snapshotter?: string;
}

/** One run's timings in seconds, by column name. */
type Sample = Record<string, number>;

const seconds = (from: Date | undefined, to: Date | undefined) =>
  ((to?.getTime() ?? Number.NaN) - (from?.getTime() ?? Number.NaN)) / 1000;

//==============================================================================
// FARGATE
//==============================================================================

async function networkConfiguration() {
  const { Stacks } = await cloudformation.send(
    new DescribeStacksCommand({ StackName: COMPUTE_STACK }),
  );
  const output = (key: string) =>
    Stacks?.[0]?.Outputs?.find(({ OutputKey }) => OutputKey === key)?.OutputValue ?? "";
  return {
    awsvpcConfiguration: {
      subnets: output("SubnetIds").split(","),
      securityGroups: [output("SecurityGroupId")],
      assignPublicIp: "ENABLED" as const,
    },
  };
}

async function readTaskResult(logGroupName: string, logStreamName: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const { events } = await logs
      .send(new GetLogEventsCommand({ logGroupName, logStreamName, startFromHead: false }))
      .catch(() => ({ events: [] }));
    const line = events?.findLast(({ message }) => message?.startsWith("{"))?.message;
    if (line) return JSON.parse(line) as WorkloadResult;
    await sleep(2_000);
  }
  throw new Error(`No result in ${logStreamName}`);
}

async function runFargateTask(variant: string): Promise<Sample> {
  const cluster = RESOURCE_PREFIX;
  const family = `${RESOURCE_PREFIX}-${variant}`;

  const { tasks: started, failures } = await ecs.send(
    new RunTaskCommand({
      cluster,
      launchType: "FARGATE",
      taskDefinition: family,
      networkConfiguration: await networkConfiguration(),
    }),
  );
  const taskArn = started?.[0]?.taskArn;
  if (!taskArn) throw new Error(`RunTask failed: ${JSON.stringify(failures)}`);

  await waitUntilTasksStopped({ client: ecs, maxWaitTime: 900 }, { cluster, tasks: [taskArn] });
  const { tasks } = await ecs.send(new DescribeTasksCommand({ cluster, tasks: [taskArn] }));
  const task = tasks?.[0];
  if (task?.containers?.[0]?.exitCode !== 0) {
    throw new Error(`${family} stopped: ${task?.stoppedReason}`);
  }

  const { taskDefinition } = await ecs.send(
    new DescribeTaskDefinitionCommand({ taskDefinition: family }),
  );
  const logGroup = taskDefinition?.containerDefinitions?.[0]?.logConfiguration?.options?.[
    "awslogs-group"
  ] as string;
  const taskId = taskArn.split("/").at(-1);
  const result = await readTaskResult(logGroup, `${variant}/Workload/${taskId}`);

  const expectedSnapshotter = variant.startsWith("soci") ? "soci" : "overlayfs";
  if (result.snapshotter !== expectedSnapshotter) {
    throw new Error(`${family} used ${result.snapshotter}, not ${expectedSnapshotter}`);
  }

  return {
    pull: seconds(task.pullStartedAt, task.pullStoppedAt),
    load: result.loadSeconds,
    ready: seconds(task.createdAt, new Date(result.startedAt * 1000)) + result.loadSeconds,
  };
}

//==============================================================================
// LAMBDA MANAGED INSTANCES
//==============================================================================

const scaleFunction = (FunctionName: string, environments: number) =>
  lambda.send(
    new PutFunctionScalingConfigCommand({
      FunctionName,
      Qualifier: LATEST_PUBLISHED,
      FunctionScalingConfig: {
        MinExecutionEnvironments: environments,
        MaxExecutionEnvironments: environments,
      },
    }),
  );

async function waitForNoInstances(FunctionName: string) {
  const { CapacityProviderConfig } = await lambda.send(
    new GetFunctionConfigurationCommand({ FunctionName, Qualifier: LATEST_PUBLISHED }),
  );
  const capacityProviderArn =
    CapacityProviderConfig?.LambdaManagedInstancesCapacityProviderConfig?.CapacityProviderArn ?? "";

  while (true) {
    const { Reservations } = await ec2.send(
      new DescribeInstancesCommand({
        // Hidden from the default listing, as Lambda owns them
        IncludeManagedResources: true,
        Filters: [
          { Name: "tag:aws:lambda:capacity-provider", Values: [capacityProviderArn] },
          { Name: "instance-state-name", Values: ["pending", "running", "stopping"] },
        ],
      }),
    );
    if (!Reservations?.some(({ Instances }) => Instances?.length)) return;
    await sleep(10_000);
  }
}

// Invokes fail until an execution environment can take them.
async function invokeUntilServed(FunctionName: string) {
  const deadline = Date.now() + INVOKE_DEADLINE_MS;
  while (Date.now() < deadline) {
    const response = await lambda.send(new InvokeCommand({ FunctionName })).catch(() => undefined);
    if (response?.FunctionError) {
      throw new Error(`${FunctionName}: ${new TextDecoder().decode(response.Payload)}`);
    }
    if (response?.Payload) {
      return JSON.parse(new TextDecoder().decode(response.Payload)) as WorkloadResult;
    }
    await sleep(1_000);
  }
  throw new Error(`${FunctionName} didn't answer in time`);
}

/** Timings from Lambda's own system log events, which arrive a little after the invoke returns. */
async function readSystemLogTimings(FunctionName: string, since: Date) {
  const logGroupName = `/aws/lambda/capacity-provider/${FunctionName}`;
  const times = new Map<string, Date>();

  for (let attempt = 0; attempt < 30; attempt++) {
    const pages = paginateFilterLogEvents(
      { client: logs },
      { logGroupName, startTime: since.getTime() - 60_000 },
    );
    for await (const { events } of pages) {
      for (const { message } of events ?? []) {
        const event = JSON.parse(message ?? "{}");
        times.set(event.message, new Date(event.timestamp));
      }
    }

    const activating = times.get("Function version is being activated.");
    const active = times.get("Function version is active.");
    const creating = times.get("Execution environment is being created.");
    const created = times.get("Execution environment created.");
    if (activating && active && creating && created && active > activating) {
      return { environment: seconds(creating, created), active: seconds(activating, active) };
    }
    await sleep(5_000);
  }
  throw new Error(`No system log timings for ${FunctionName}`);
}

// Deactivating terminates the instances, so reactivating starts with an empty image cache.
async function runLmiColdStart(variant: string): Promise<Sample> {
  const functionName = `${RESOURCE_PREFIX}-${variant}`;

  await scaleFunction(functionName, 0);
  await waitForNoInstances(functionName);

  const requestedAt = new Date();
  await scaleFunction(functionName, 1);
  const result = await invokeUntilServed(functionName);
  const timings = await readSystemLogTimings(functionName, requestedAt);

  await scaleFunction(functionName, 0);
  return { ...timings, load: result.loadSeconds, firstRequest: result.requestSeconds };
}

//==============================================================================
// REPORT
//==============================================================================

const median = (values: number[]) => values.toSorted((a, b) => a - b)[(values.length - 1) >> 1];

function summarize(variant: string, samples: Sample[]) {
  const row: Record<string, string> = { variant };
  for (const column of Object.keys(samples[0] ?? {})) {
    const values = samples.map((sample) => sample[column]);
    row[column] =
      `${median(values).toFixed(1)} (${Math.min(...values).toFixed(1)}-${Math.max(...values).toFixed(1)})`;
  }
  return row;
}

// Variants run side by side, each on its own capacity, so a run takes as long as its slowest one.
async function measure(
  service: string,
  variants: readonly { name: string }[],
  sample: (variant: string) => Promise<Sample>,
) {
  const samples = new Map<string, Sample[]>(variants.map(({ name }) => [name, []]));
  for (let run = 1; run <= RUNS; run++) {
    console.log(`${service}: run ${run}/${RUNS}`);
    await Promise.all(
      variants.map(async ({ name }) => {
        samples.get(name)?.push(await sample(name));
      }),
    );
  }
  return variants.map(({ name }) => summarize(name, samples.get(name) ?? []));
}

const [fargate, lmi] = await Promise.all([
  measure(
    "Fargate",
    VARIANTS.filter(({ loadAt }) => loadAt === "init"),
    runFargateTask,
  ),
  measure("LMI", VARIANTS, runLmiColdStart),
]);

console.log(`Seconds, median (min-max) of ${RUNS} runs`);
console.log("Fargate");
console.table(fargate);
console.log("Lambda Managed Instances");
console.table(lmi);
