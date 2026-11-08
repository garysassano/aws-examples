import { Logger } from "@aws-lambda-powertools/logger";
import { DescribeTaskDefinitionCommand, ECSClient } from "@aws-sdk/client-ecs";
import type { Context, EventBridgeEvent } from "aws-lambda";

/** The fields of an ECS Task State Change event that the tagger reads. */
interface TaskStateChange {
  clusterArn: string;
  /** `service:<name>` for a service's tasks, `family:<name>` for a standalone task. */
  group: string;
  taskArn: string;
  taskDefinitionArn: string;
  stopCode: string;
  stoppedReason: string;
  containers: { name: string; exitCode?: number; reason?: string }[];
}

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

/** ECS puts platform errors before a colon, as in `CannotPullContainerError: ...`. */
const getError = ({ stopCode, stoppedReason }: TaskStateChange) => {
  const separator = stoppedReason.indexOf(": ");
  if (separator > 0) {
    return { code: stoppedReason.slice(0, separator), message: stoppedReason.slice(separator + 2) };
  }
  return { code: stopCode, message: stoppedReason };
};

export const handler = async (
  event: EventBridgeEvent<"ECS Task State Change", TaskStateChange>,
  context: Context,
): Promise<void> => {
  logger.addContext(context);

  const { detail } = event;
  const [groupType, groupName] = detail.group.split(":", 2);
  const error = getError(detail);

  logger.info("ECS task stopped with an error", {
    ecs_cluster: detail.clusterArn.split("/").pop(),
    ecs_service: groupType === "service" ? groupName : undefined,
    ecs_task_id: detail.taskArn.split("/").pop(),
    ecs_task_definition: detail.taskDefinitionArn.split("/").pop(),
    error_code: error.code,
    error_message: error.message,
    exit_codes: Object.fromEntries(
      detail.containers
        .filter((container) => container.exitCode !== undefined)
        .map((container) => [container.name, container.exitCode]),
    ),
    tags: await getTags(detail.taskDefinitionArn),
  });
};
