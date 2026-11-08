import { Logger } from "@aws-lambda-powertools/logger";
import { parse } from "@aws-lambda-powertools/parser";
import { EventBridgeEnvelope } from "@aws-lambda-powertools/parser/envelopes/eventbridge";
import { DescribeTaskDefinitionCommand, ECSClient } from "@aws-sdk/client-ecs";
import type { Context } from "aws-lambda";
import { z } from "zod";

/**
 * The fields of an ECS Task State Change event's `detail` that the tagger reads, optional
 * where the `aws.ecs@ECSTaskStateChange` schema in the EventBridge schema registry says so.
 * Powertools ships no ECS schema, so this extends its EventBridge envelope.
 */
const TaskStateChange = z.object({
  clusterArn: z.string(),
  /** `service:<name>` for a service's tasks, `family:<name>` for a standalone task. */
  group: z.string().optional(),
  taskArn: z.string(),
  taskDefinitionArn: z.string(),
  stopCode: z.string().optional(),
  stoppedReason: z.string().optional(),
  containers: z.array(
    z.object({
      name: z.string(),
      exitCode: z.number().optional(),
      reason: z.string().optional(),
    }),
  ),
});
type TaskStateChange = z.infer<typeof TaskStateChange>;

const ecs = new ECSClient();
const logger = new Logger();

// A failing service sends many events for the same task definition revision, whose
// tags this environment then reads only once.
const tagsByTaskDefinition = new Map<string, Record<string, string>>();

const getTags = async (taskDefinition: string) => {
  const cached = tagsByTaskDefinition.get(taskDefinition);
  if (cached) return cached;

  const response = await ecs.send(
    new DescribeTaskDefinitionCommand({ taskDefinition, include: ["TAGS"] }),
  );
  const tags: Record<string, string> = {};
  for (const { key, value } of response.tags ?? []) {
    if (key) tags[key] = value ?? "";
  }
  tagsByTaskDefinition.set(taskDefinition, tags);
  return tags;
};

/**
 * ECS names the error category before a colon. On Fargate it comes first, as in
 * `ResourceInitializationError: unable to pull secrets ...`, but the docs also show it
 * after context, as in `Fetching secret data ...: ResourceNotFoundException: ...`, so
 * the first category anywhere in the reason wins.
 */
const ERROR_CATEGORY = /\b([A-Z][A-Za-z]*(?:Error|Exception)):/;

const getErrorCode = ({ stopCode, stoppedReason = "" }: TaskStateChange) =>
  ERROR_CATEGORY.exec(stoppedReason)?.[1] ?? stopCode;

export const handler = async (event: unknown, context: Context): Promise<void> => {
  logger.addContext(context);

  const detail = parse(event, EventBridgeEnvelope, TaskStateChange);
  const [groupType, groupName] = detail.group?.split(":", 2) ?? [];

  logger.info("ECS task stopped with an error", {
    ecs_cluster: detail.clusterArn.split("/").pop(),
    ecs_service: groupType === "service" ? groupName : undefined,
    ecs_task_id: detail.taskArn.split("/").pop(),
    ecs_task_definition: detail.taskDefinitionArn.split("/").pop(),
    error_code: getErrorCode(detail),
    error_message: detail.stoppedReason,
    exit_codes: Object.fromEntries(
      detail.containers
        .filter((container) => container.exitCode !== undefined)
        .map((container) => [container.name, container.exitCode]),
    ),
    tags: await getTags(detail.taskDefinitionArn),
  });
};
