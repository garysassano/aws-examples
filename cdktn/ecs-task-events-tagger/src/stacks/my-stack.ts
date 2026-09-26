import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TerraformStack } from "cdktn";
import type { Construct } from "constructs";
import { CloudwatchEventRule } from "../../.gen/providers/aws/cloudwatch-event-rule/index.js";
import { CloudwatchEventTarget } from "../../.gen/providers/aws/cloudwatch-event-target/index.js";
import { DataAwsIamPolicyDocument } from "../../.gen/providers/aws/data-aws-iam-policy-document/index.js";
import { DataAwsSubnets } from "../../.gen/providers/aws/data-aws-subnets/index.js";
import { DataAwsVpc } from "../../.gen/providers/aws/data-aws-vpc/index.js";
import { EcsCluster } from "../../.gen/providers/aws/ecs-cluster/index.js";
import { EcsService } from "../../.gen/providers/aws/ecs-service/index.js";
import { EcsTaskDefinition } from "../../.gen/providers/aws/ecs-task-definition/index.js";
import { IamRole } from "../../.gen/providers/aws/iam-role/index.js";
import { LambdaFunction } from "../../.gen/providers/aws/lambda-function/index.js";
import { LambdaPermission } from "../../.gen/providers/aws/lambda-permission/index.js";
import { AwsProvider } from "../../.gen/providers/aws/provider/index.js";
import { DataNodeLambdaPackagerPackage } from "../../.gen/providers/node-lambda-packager/data-node-lambda-packager-package/index.js";
import { NodeLambdaPackagerProvider } from "../../.gen/providers/node-lambda-packager/provider/index.js";

const functionDir = join(dirname(fileURLToPath(import.meta.url)), "../functions/tagger");

export class MyStack extends TerraformStack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new AwsProvider(this, "AwsProvider");
    new NodeLambdaPackagerProvider(this, "NodeLambdaPackagerProvider");

    /*
     * DEFAULT VPC & SUBNETS
     */

    // Fetch region's default VPC
    const defaultVpc = new DataAwsVpc(this, "defaultVpc", {
      default: true,
    });

    // Fetch subnets from region's default VPC
    const defaultVpcSubnets = new DataAwsSubnets(this, "defaultVpcSubnets", {
      filter: [
        {
          name: "vpc-id",
          values: [defaultVpc.id],
        },
      ],
    });

    /*
     * IAM POLICIES
     */

    const lambdaAssumeRolePolicy = new DataAwsIamPolicyDocument(this, "LambdaAssumeRolePolicy", {
      version: "2012-10-17",
      statement: [
        {
          effect: "Allow",
          principals: [
            {
              type: "Service",
              identifiers: ["lambda.amazonaws.com"],
            },
          ],
          actions: ["sts:AssumeRole"],
        },
      ],
    });

    const ecsTasksAssumeRolePolicy = new DataAwsIamPolicyDocument(
      this,
      "ECSTasksAssumeRolePolicy",
      {
        version: "2012-10-17",
        statement: [
          {
            effect: "Allow",
            principals: [
              {
                type: "Service",
                identifiers: ["ecs-tasks.amazonaws.com"],
              },
            ],
            actions: ["sts:AssumeRole"],
          },
        ],
      },
    );

    const cwLogsPolicy = new DataAwsIamPolicyDocument(this, "CWLogsPolicy", {
      version: "2012-10-17",
      statement: [
        {
          effect: "Allow",
          actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
          resources: ["*"],
        },
      ],
    });

    const ecsPolicy = new DataAwsIamPolicyDocument(this, "ECSPolicy", {
      version: "2012-10-17",
      statement: [
        {
          effect: "Allow",
          actions: ["ecs:DescribeTaskDefinition"],
          resources: ["*"],
        },
      ],
    });

    /*
     * IAM ROLES
     */

    const ecsTaskExecutionRole = new IamRole(this, "ECSTaskExecutionRole", {
      name: "ecs-task-execution-role",
      assumeRolePolicy: ecsTasksAssumeRolePolicy.json,
      inlinePolicy: [
        {
          name: "cw-logs-policy",
          policy: cwLogsPolicy.json,
        },
      ],
    });

    const ecsEventsTaggerRole = new IamRole(this, "ECSEventsTaggerRole", {
      name: "ecs-events-tagger-role",
      assumeRolePolicy: lambdaAssumeRolePolicy.json,
      inlinePolicy: [
        {
          name: "cw-logs-policy",
          policy: cwLogsPolicy.json,
        },
        {
          name: "ecs-policy",
          policy: ecsPolicy.json,
        },
      ],
    });

    /*
     * ECS CLUSTER, SERVICE & TASK
     */

    const ecsCluster = new EcsCluster(this, "EcsCluster", {
      name: "ecs-cluster",
    });

    const ecsTask = new EcsTaskDefinition(this, "ECSTask", {
      family: "ecs-task",
      requiresCompatibilities: ["FARGATE"],
      networkMode: "awsvpc",
      cpu: "256",
      memory: "512",
      runtimePlatform: {
        operatingSystemFamily: "LINUX",
        cpuArchitecture: "X86_64",
      },
      executionRoleArn: ecsTaskExecutionRole.arn,
      containerDefinitions: JSON.stringify([
        {
          name: "unexisting-image",
          image: "unexisting-image",
        },
      ]),
      tags: {
        project: "example",
        environment: "dev",
        owner: "someone",
      },
    });

    new EcsService(this, "EcsService", {
      name: "ecs-service",
      cluster: ecsCluster.id,
      taskDefinition: ecsTask.arn,
      launchType: "FARGATE",
      networkConfiguration: {
        subnets: defaultVpcSubnets.ids,
        assignPublicIp: true,
      },
      desiredCount: 1,
    });

    /*
     * AWS LAMBDA
     */

    const ecsEventsTaggerPackage = new DataNodeLambdaPackagerPackage(
      this,
      "ECSEventsTaggerPackage",
      {
        args: [
          "--bundle",
          "--minify",
          "--sourcemap",
          "--platform=node",
          "--target=es2024",
          // Pin the Lambda's tsconfig; esbuild otherwise walks up to the app's
          `--tsconfig=${join(functionDir, "tsconfig.json")}`,
        ],
        entrypoint: join(functionDir, "index.ts"),
        workingDirectory: functionDir,
      },
    );

    const ecsEventsTagger = new LambdaFunction(this, "ECSEventsTagger", {
      functionName: "ecs-events-tagger",
      description: "Function for tagging and slimming ECS Task error events",
      role: ecsEventsTaggerRole.arn,
      runtime: "nodejs24.x",
      filename: ecsEventsTaggerPackage.filename,
      sourceCodeHash: ecsEventsTaggerPackage.sourceCodeHash,
      handler: "index.handler",
      architectures: ["arm64"],
      memorySize: 1024,
      timeout: 5,
      loggingConfig: {
        logFormat: "JSON",
        systemLogLevel: "WARN",
      },
      environment: {
        variables: {
          POWERTOOLS_SERVICE_NAME: "ecs-events-tagger",
        },
      },
    });

    /*
     * EVENTBRIDGE TO LAMBDA
     */

    const ecsErroredTasksEventRule = new CloudwatchEventRule(this, "ECSErroredTasksEventRule", {
      name: "ecs-errored-tasks",
      description: "Triggered when an ECS Task stops because of an error",
      eventPattern: JSON.stringify({
        source: ["aws.ecs"],
        "detail-type": ["ECS Task State Change"],
        detail: {
          desiredStatus: ["STOPPED"],
          lastStatus: ["STOPPED"],
          $or: [
            /*
                Matches ECS Task events with the following conditions:
                  - The stop code is "EssentialContainerExited"
                  - Any container in the task exited with a non-zero exit code
              */
            {
              stopCode: ["EssentialContainerExited"],
              containers: { exitCode: [{ "anything-but": 0 }] },
            },
            /*
                Matches ECS Task events with the following conditions:
                  - The stop code is "TaskFailedToStart"
              */
            {
              stopCode: ["TaskFailedToStart"],
            },
            /*
                Matches any of the following ECS Task error codes:
                  - CannotCreateVolumeError
                  - CannotInspectContainerError
                  - CannotPullContainerError
                  - CannotStartContainerError
                  - CannotStopContainerError
                  - ContainerRuntimeError
                  - ContainerRuntimeTimeoutError
                  - InternalError
                  - OutOfMemoryError
                  - ResourceInitializationError
              */
            {
              stoppedReason: [{ wildcard: "*Error:*" }],
            },
          ],
        },
      }),
    });

    new CloudwatchEventTarget(this, "ECSErroredTasksEventTarget", {
      rule: ecsErroredTasksEventRule.name,
      arn: ecsEventsTagger.arn,
    });

    new LambdaPermission(this, "ECSEventsTaggerEventbridgePermission", {
      action: "lambda:InvokeFunction",
      functionName: ecsEventsTagger.functionName,
      principal: "events.amazonaws.com",
      sourceArn: ecsErroredTasksEventRule.arn,
    });
  }
}
