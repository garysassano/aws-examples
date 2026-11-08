import { join } from "node:path";
import { TerraformStack } from "cdktn";
import type { Construct } from "constructs";
import { CloudwatchEventRule } from "../../.gen/providers/aws/cloudwatch-event-rule/index.js";
import { CloudwatchEventTarget } from "../../.gen/providers/aws/cloudwatch-event-target/index.js";
import { CloudwatchLogGroup } from "../../.gen/providers/aws/cloudwatch-log-group/index.js";
import { CloudwatchLogResourcePolicy } from "../../.gen/providers/aws/cloudwatch-log-resource-policy/index.js";
import { DataAwsSubnets } from "../../.gen/providers/aws/data-aws-subnets/index.js";
import { DataAwsVpc } from "../../.gen/providers/aws/data-aws-vpc/index.js";
import { EcsCluster } from "../../.gen/providers/aws/ecs-cluster/index.js";
import { EcsService } from "../../.gen/providers/aws/ecs-service/index.js";
import { EcsTaskDefinition } from "../../.gen/providers/aws/ecs-task-definition/index.js";
import { IamRole } from "../../.gen/providers/aws/iam-role/index.js";
import { IamRolePolicy } from "../../.gen/providers/aws/iam-role-policy/index.js";
import { LambdaFunction } from "../../.gen/providers/aws/lambda-function/index.js";
import { LambdaPermission } from "../../.gen/providers/aws/lambda-permission/index.js";
import { AwsProvider } from "../../.gen/providers/aws/provider/index.js";
import { DataNodeLambdaPackagerPackage } from "../../.gen/providers/node-lambda-packager/data-node-lambda-packager-package/index.js";
import { NodeLambdaPackagerProvider } from "../../.gen/providers/node-lambda-packager/provider/index.js";

const name = "ecs-task-events";
const taggerDir = join(import.meta.dirname, "../functions/tagger");

export class MyStack extends TerraformStack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new AwsProvider(this, "AwsProvider");
    new NodeLambdaPackagerProvider(this, "NodeLambdaPackagerProvider");

    /*
     * FAILING SERVICE
     */

    // The task pulls a public image and needs no NAT gateway, so it runs in the
    // default VPC's public subnets.
    const defaultVpc = new DataAwsVpc(this, "DefaultVpc", { default: true });
    const subnets = new DataAwsSubnets(this, "DefaultSubnets", {
      filter: [{ name: "vpc-id", values: [defaultVpc.id] }],
    });

    const cluster = new EcsCluster(this, "Cluster", { name });

    // The container exits with code 1 as soon as it starts, so every task stops with
    // an error and ECS keeps replacing it. The task pulls from a public registry and
    // has no log driver, so it needs no execution role. The tagger copies these
    // tags into each record.
    const taskDefinition = new EcsTaskDefinition(this, "FailingTask", {
      family: `${name}-failing`,
      requiresCompatibilities: ["FARGATE"],
      networkMode: "awsvpc",
      cpu: "256",
      memory: "512",
      runtimePlatform: { operatingSystemFamily: "LINUX", cpuArchitecture: "ARM64" },
      containerDefinitions: JSON.stringify([
        {
          name: "app",
          image: "public.ecr.aws/docker/library/busybox:stable",
          command: ["false"],
          essential: true,
        },
      ]),
      tags: { project: "example", environment: "dev", owner: "someone" },
    });

    new EcsService(this, "FailingService", {
      name: `${name}-failing`,
      cluster: cluster.id,
      taskDefinition: taskDefinition.arn,
      launchType: "FARGATE",
      desiredCount: 1,
      networkConfiguration: { subnets: subnets.ids, assignPublicIp: true },
    });

    /*
     * RAW EVENTS: EVENTBRIDGE TO CLOUDWATCH LOGS
     */

    const rawEvents = new CloudwatchLogGroup(this, "RawEvents", {
      name: `/aws/events/${name}`,
      retentionInDays: 7,
    });

    // Scoped to the log group, so it doesn't use one of the account's 10 Region-wide
    // CloudWatch Logs resource policies.
    new CloudwatchLogResourcePolicy(this, "RawEventsPolicy", {
      resourceArn: rawEvents.arn,
      policyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "events.amazonaws.com" },
            Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
            Resource: `${rawEvents.arn}:*`,
          },
        ],
      }),
    });

    /*
     * TAGGED EVENTS: EVENTBRIDGE TO LAMBDA
     */

    const taggerLogs = new CloudwatchLogGroup(this, "TaggerLogs", {
      name: `/aws/lambda/${name}-tagger`,
      retentionInDays: 7,
    });

    const taggerRole = new IamRole(this, "TaggerRole", {
      name: `${name}-tagger`,
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "lambda.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      }),
    });

    // Without logs:CreateLogGroup, Lambda cannot recreate the group after a destroy.
    new IamRolePolicy(this, "TaggerWritesLogs", {
      name: "write-logs",
      role: taggerRole.name,
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
            Resource: `${taggerLogs.arn}:*`,
          },
        ],
      }),
    });

    // DescribeTaskDefinition supports no resource-level permissions.
    new IamRolePolicy(this, "TaggerReadsTaskDefinitions", {
      name: "read-task-definitions",
      role: taggerRole.name,
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: "ecs:DescribeTaskDefinition", Resource: "*" }],
      }),
    });

    const taggerPackage = new DataNodeLambdaPackagerPackage(this, "TaggerPackage", {
      args: [
        "--bundle",
        "--minify",
        "--sourcemap",
        "--platform=node",
        "--target=node24",
        // Pin the function's tsconfig; esbuild otherwise walks up to the app's.
        `--tsconfig=${join(taggerDir, "tsconfig.json")}`,
      ],
      entrypoint: join(taggerDir, "index.ts"),
      workingDirectory: taggerDir,
    });

    const tagger = new LambdaFunction(this, "Tagger", {
      functionName: `${name}-tagger`,
      description: "Slims ECS task error events and adds the task definition's tags",
      role: taggerRole.arn,
      runtime: "nodejs24.x",
      architectures: ["arm64"],
      memorySize: 256,
      timeout: 10,
      filename: taggerPackage.filename,
      sourceCodeHash: taggerPackage.sourceCodeHash,
      handler: "index.handler",
      environment: {
        variables: {
          NODE_OPTIONS: "--enable-source-maps",
          POWERTOOLS_SERVICE_NAME: `${name}-tagger`,
        },
      },
      loggingConfig: {
        logFormat: "JSON",
        logGroup: taggerLogs.name,
        systemLogLevel: "WARN",
      },
    });

    /*
     * EVENT RULE
     */

    // Matches tasks that stopped because of an error, in any cluster in the Region.
    const rule = new CloudwatchEventRule(this, "ErroredTasks", {
      name: `${name}-errored`,
      description: "ECS tasks that stopped because of an error",
      eventPattern: JSON.stringify({
        source: ["aws.ecs"],
        "detail-type": ["ECS Task State Change"],
        detail: {
          desiredStatus: ["STOPPED"],
          lastStatus: ["STOPPED"],
          $or: [
            // An essential container exited with a non-zero code.
            {
              stopCode: ["EssentialContainerExited"],
              containers: { exitCode: [{ "anything-but": 0 }] },
            },
            // The task never reached RUNNING.
            { stopCode: ["TaskFailedToStart"] },
            // One of the stopped task error categories, such as CannotPullContainerError or
            // ResourceNotFoundException, which ECS puts before a colon.
            { stoppedReason: [{ wildcard: "*Error:*" }, { wildcard: "*Exception:*" }] },
          ],
        },
      }),
    });

    new CloudwatchEventTarget(this, "ErroredTasksToRawEvents", {
      rule: rule.name,
      targetId: "raw-events",
      arn: rawEvents.arn,
    });

    new CloudwatchEventTarget(this, "ErroredTasksToTagger", {
      rule: rule.name,
      targetId: "tagger",
      arn: tagger.arn,
    });

    new LambdaPermission(this, "RuleInvokesTagger", {
      action: "lambda:InvokeFunction",
      functionName: tagger.functionName,
      principal: "events.amazonaws.com",
      sourceArn: rule.arn,
    });
  }
}
