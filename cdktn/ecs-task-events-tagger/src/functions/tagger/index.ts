import { Logger } from "@aws-lambda-powertools/logger";
import { ECSClient, DescribeTaskDefinitionCommand } from "@aws-sdk/client-ecs";
import middy from "@middy/core";
import httpErrorHandler from "@middy/http-error-handler";
import { EventBridgeEvent } from "aws-lambda";

interface ECSTaskStateChangeDetail {
  attachments: {
    id: string;
    type: string;
    status: string;
    details: {
      name: string;
      value: string;
    }[];
  }[];
  attributes: {
    name: string;
    value: string;
  }[];
  availabilityZone: string;
  clusterArn: string;
  connectivity: string;
  connectivityAt: string;
  containers: {
    containerArn: string;
    lastStatus: string;
    name: string;
    image: string;
    runtimeId: string;
    taskArn: string;
    networkInterfaces: {
      attachmentId: string;
      privateIpv4Address: string;
    }[];
    cpu: string;
    managedAgents: {
      name: string;
      status: string;
    }[];
  }[];
  cpu: string;
  createdAt: string;
  desiredStatus: string;
  enableExecuteCommand: boolean;
  ephemeralStorage: {
    sizeInGiB: number;
  };
  executionStoppedAt: string;
  group: string;
  launchType: string;
  lastStatus: string;
  memory: string;
  overrides: {
    containerOverrides: {
      name: string;
    }[];
  };
  platformVersion: string;
  startedBy: string;
  stoppingAt: string;
  stoppedAt: string;
  stoppedReason: string;
  stopCode: string;
  taskArn: string;
  taskDefinitionArn: string;
  updatedAt: string;
  version: number;
}

const ecsClient = new ECSClient();
const logger = new Logger();

const lambdaHandler = async (
  event: EventBridgeEvent<string, ECSTaskStateChangeDetail>,
): Promise<void> => {
  const command = new DescribeTaskDefinitionCommand({
    taskDefinition: event.detail.taskDefinitionArn,
    include: ["TAGS"],
  });
  const response = await ecsClient.send(command);

  let errorCode = "UnknownError";
  let errorMessage = "An unknown error occurred";

  if (!event.detail.stoppedReason.includes(":")) {
    switch (event.detail.stopCode) {
      case "EssentialContainerExited":
        errorCode = "EssentialContainerExited";
        errorMessage = "Essential container in task exited";
        break;
      case "TaskFailedToStart":
        errorCode = "TaskFailedToStart";
        errorMessage = "Task failed to transition to a RUNNING state";
        break;
    }
  } else {
    [errorCode, errorMessage] = event.detail.stoppedReason.split(": ", 2);
  }

  const modifiedPayload = {
    ecs_cluster: event.detail.clusterArn.split("/").pop(),
    ecs_service: event.detail.group.split(":").pop(),
    ecs_task_id: event.detail.taskArn.split("/").pop(),
    error_code: errorCode,
    error_message: errorMessage,
    tags: Object.fromEntries(
      response.tags?.map((tag) => [tag.key, tag.value]) ?? [],
    ),
  };

  logger.info("ECS Task stopped with error", modifiedPayload);
};

export const handler = middy(lambdaHandler).use(httpErrorHandler());
