import { join } from "node:path";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Architecture, LoggingFormat, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { CfnAccountPolicy } from "aws-cdk-lib/aws-logs";
import { Schedule, ScheduleExpression } from "aws-cdk-lib/aws-scheduler";
import { LambdaInvoke } from "aws-cdk-lib/aws-scheduler-targets";
import { Duration, Stack, type StackProps } from "aws-cdk-lib/core";
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
} from "aws-cdk-lib/custom-resources";
import { RustExtension } from "cargo-lambda-cdk";
import type { Construct } from "constructs";
import { DESTINATION_NAME, EVENT_BUS_NAME, type Transport } from "../utils/transport.js";

export interface OtlpSenderStackProps extends StackProps {
  readonly transport: Transport;
  readonly targetAccount: string;
}

// The source account: a function whose spans travel to the target account.
export class OtlpSenderStack extends Stack {
  constructor(scope: Construct, id: string, props: OtlpSenderStackProps) {
    super(scope, id, props);

    const { transport, targetAccount } = props;

    //==============================================================================
    // HELLO FUNCTION (LAMBDA)
    //==============================================================================

    const hello = new NodejsFunction(this, "Hello", {
      functionName: "hello",
      entry: join(import.meta.dirname, "../functions/hello", "index.ts"),
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.minutes(1),
      loggingFormat: LoggingFormat.JSON,
    });

    new Schedule(this, "HelloSchedule", {
      scheduleName: "hello-schedule",
      description: `Trigger ${hello.functionName} every minute`,
      schedule: ScheduleExpression.rate(Duration.minutes(1)),
      target: new LambdaInvoke(hello),
    });

    //==============================================================================
    // OTLP TRANSPORT
    //==============================================================================

    switch (transport) {
      case "logs-destination": {
        // The destination admits the whole organization, so CloudWatch Logs assumes this
        // role to confirm that this account belongs to it.
        const subscriptionRole = new Role(this, "OtlpSubscriptionRole", {
          assumedBy: new ServicePrincipal("logs.amazonaws.com"),
        });
        subscriptionRole.addToPolicy(
          new PolicyStatement({
            actions: ["logs:PutLogEvents"],
            resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:*`],
          }),
        );

        // Every log group sends its otlp-stdout lines to the destination in the target
        // account, which writes them to Kinesis there.
        const otlpAccountSubFilter = new CfnAccountPolicy(this, "OtlpAccountSubFilter", {
          policyName: "OtlpAccountSubFilter",
          policyDocument: JSON.stringify({
            DestinationArn: `arn:aws:logs:${this.region}:${targetAccount}:destination:${DESTINATION_NAME}`,
            RoleArn: subscriptionRole.roleArn,
            FilterPattern: "{ $.__otel_otlp_stdout = * }",
            Distribution: "Random",
          }),
          policyType: "SUBSCRIPTION_FILTER_POLICY",
          scope: "ALL",
        });
        // CloudWatch Logs assumes the role while creating the filter.
        otlpAccountSubFilter.node.addDependency(subscriptionRole);
        break;
      }
      case "logs-centralization": {
        // Nothing to deploy here: the centralization rule in the target account copies
        // this account's log groups.
        break;
      }
      case "event-bus": {
        // The bus ARN ends in an ID the service generates, so look it up by name among
        // the buses the target account shares with this one.
        const sharedBus = new AwsCustomResource(this, "SharedEventBus", {
          onUpdate: {
            service: "EventBridgeV2",
            action: "listEventBuses",
            parameters: { NamePrefix: EVENT_BUS_NAME, EventBusAccountId: targetAccount },
            physicalResourceId: PhysicalResourceId.fromResponse("EventBuses.0.EventBusArn"),
            outputPaths: ["EventBuses.0.EventBusArn"],
          },
          policy: AwsCustomResourcePolicy.fromStatements([
            new PolicyStatement({ actions: ["events:ListEventBuses"], resources: ["*"] }),
          ]),
          // The Lambda runtime's bundled SDK predates the EventBridgeV2 client.
          installLatestAwsSdk: true,
        });
        const eventBusArn = sharedBus.getResponseField("EventBuses.0.EventBusArn");

        // The extension reads the spans the functions write to its pipe and publishes
        // them to the shared bus, so they never pass through CloudWatch Logs.
        const otlpStdoutEventBusExtension = new RustExtension(this, "OtlpStdoutEventBusExtension", {
          layerVersionName: "otlp-stdout-eventbus-extension",
          manifestPath: join(
            import.meta.dirname,
            "../layers/otlp-stdout-eventbus-extension",
            "Cargo.toml",
          ),
          architecture: Architecture.ARM_64,
          bundling: { cargoLambdaFlags: ["--quiet"] },
        });

        hello.addLayers(otlpStdoutEventBusExtension);
        hello.addToRolePolicy(
          new PolicyStatement({ actions: ["events:PutRawEvents"], resources: [eventBusArn] }),
        );
        hello.addEnvironment("OTEL_LITE_EXTENSION_EVENT_BUS_ARN", eventBusArn);
        // Platform telemetry stays off, so the bus carries the same spans as the two
        // CloudWatch Logs transports and their delivery latency compares like for like.
        hello.addEnvironment("OTLP_STDOUT_SPAN_EXPORTER_OUTPUT_TYPE", "pipe");
        break;
      }
    }
  }
}
