import { join } from "node:path";
import { ManagedPolicy, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Stream } from "aws-cdk-lib/aws-kinesis";
import {
  ApplicationLogLevel,
  Architecture,
  LoggingFormat,
  StartingPosition,
  SystemLogLevel,
} from "aws-cdk-lib/aws-lambda";
import { KinesisEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { CfnAccountPolicy, CfnDestination } from "aws-cdk-lib/aws-logs";
import { CfnOrganizationCentralizationRule } from "aws-cdk-lib/aws-observabilityadmin";
import { CfnResourceShare } from "aws-cdk-lib/aws-ram";
import { Queue } from "aws-cdk-lib/aws-sqs";
import {
  CfnOutput,
  CfnResource,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  Validations,
} from "aws-cdk-lib/core";
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
} from "aws-cdk-lib/custom-resources";
import { RustFunction } from "cargo-lambda-cdk";
import type { Construct } from "constructs";
import {
  DESTINATION_NAME,
  EVENT_BUS_NAME,
  FORWARDER_NAME,
  type Transport,
} from "../utils/transport.js";

// The forwarder's own log group, which a subscription in this account must skip so the
// forwarder does not receive its own output.
const FORWARDER_LOG_GROUP = `/aws/lambda/${FORWARDER_NAME}`;

export interface OtlpReceiverStackProps extends StackProps {
  readonly transport: Transport;
}

// The target account: receives the spans through the chosen transport and forwards
// them to its own CloudWatch OTLP endpoint.
export class OtlpReceiverStack extends Stack {
  constructor(scope: Construct, id: string, props: OtlpReceiverStackProps) {
    super(scope, id, props);

    const { transport } = props;

    //==============================================================================
    // OTLP FORWARDER (LAMBDA)
    //==============================================================================

    const otlpForwarder = new RustFunction(this, "OtlpForwarder", {
      functionName: FORWARDER_NAME,
      manifestPath: join(import.meta.dirname, "../functions/otlp-forwarder", "Cargo.toml"),
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.minutes(15),
      loggingFormat: LoggingFormat.JSON,
      systemLogLevelV2: SystemLogLevel.WARN,
      applicationLogLevelV2: ApplicationLogLevel.INFO,
      bundling: { cargoLambdaFlags: ["--quiet"] },
      environment: {
        // Lambda OTel Lite
        LAMBDA_EXTENSION_SPAN_PROCESSOR_MODE: "async",
        LAMBDA_TRACING_ENABLE_FMT_LAYER: "true",
        // Labels the forwarder's delivery latency metric
        OTLP_TRANSPORT: transport,
      },
    });

    //==============================================================================
    // OTLP EXPORTER (CLOUDWATCH)
    //==============================================================================

    // The forwarder signs its requests with SigV4, which the CloudWatch OTLP endpoint
    // requires. The spans land in this account's Transaction Search.
    otlpForwarder.addEnvironment(
      "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
      `https://xray.${this.region}.amazonaws.com/v1/traces`,
    );
    otlpForwarder.role?.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName("AWSXrayWriteOnlyAccess"),
    );

    //==============================================================================
    // OTLP TRANSPORT
    //==============================================================================

    // Every account in the organization may send spans, so each transport is scoped to
    // the organization rather than to one source account.
    const organization = new AwsCustomResource(this, "Organization", {
      onUpdate: {
        service: "Organizations",
        action: "describeOrganization",
        physicalResourceId: PhysicalResourceId.fromResponse("Organization.Id"),
        outputPaths: ["Organization.Id", "Organization.Arn"],
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });
    const orgId = organization.getResponseField("Organization.Id");
    const orgArn = organization.getResponseField("Organization.Arn");

    switch (transport) {
      case "logs-destination": {
        // The destination receives the subscription deliveries from the source account
        // and writes each one to Kinesis, still gzipped as CloudWatch Logs sent it.
        const otlpStream = new Stream(this, "OtlpStream", {
          streamName: "otlp-stream",
          shardCount: 1,
          retentionPeriod: Duration.days(1),
          removalPolicy: RemovalPolicy.DESTROY,
        });

        const destinationRole = new Role(this, "OtlpDestinationRole", {
          assumedBy: new ServicePrincipal("logs.amazonaws.com"),
        });
        otlpStream.grantWrite(destinationRole);

        const destination = new CfnDestination(this, "OtlpDestination", {
          destinationName: DESTINATION_NAME,
          targetArn: otlpStream.streamArn,
          roleArn: destinationRole.roleArn,
          // Any account in the organization may subscribe. CloudWatch Logs checks the
          // organization through the role each sender passes with its filter.
          destinationPolicy: this.toJsonString({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: "*",
                Action: ["logs:PutSubscriptionFilter", "logs:PutAccountPolicy"],
                Resource: `arn:aws:logs:${this.region}:${this.account}:destination:${DESTINATION_NAME}`,
                Condition: { StringEquals: { "aws:PrincipalOrgID": [orgId] } },
              },
            ],
          }),
        });
        // CloudWatch Logs checks that it can write to the stream when the destination
        // is created, so the role's policy must exist first.
        destination.node.addDependency(destinationRole);

        otlpForwarder.addEventSource(
          new KinesisEventSource(otlpStream, {
            startingPosition: StartingPosition.LATEST,
            batchSize: 100,
            maxBatchingWindow: Duration.seconds(5),
          }),
        );
        break;
      }
      case "logs-centralization": {
        // This account is the CloudWatch delegated administrator, so it can own the rule
        // that copies the source account's Lambda log groups here.
        new CfnOrganizationCentralizationRule(this, "OtlpCentralizationRule", {
          ruleName: "otlp-centralization",
          rule: {
            source: {
              regions: [this.region],
              scope: `OrganizationId = '${orgId}'`,
              sourceLogsConfiguration: {
                // The scope also covers this account, so leave out the forwarder's own
                // log group: its spans would come back to it as copies.
                logGroupSelectionCriteria: `LogGroupName LIKE '/aws/lambda/%' AND LogGroupName != '${FORWARDER_LOG_GROUP}'`,
                encryptedLogGroupStrategy: "SKIP",
              },
            },
            destination: {
              region: this.region,
              account: this.account,
              destinationLogsConfiguration: {
                logGroupNameConfiguration: {
                  // biome-ignore lint/suspicious/noTemplateCurlyInString: CloudWatch centralization attributes, not a JS template literal
                  logGroupNamePattern: "/centralized/${source.accountId}${source.logGroup}",
                },
              },
            },
          },
        });

        // The copies are ordinary log groups in this account, so an account-level
        // subscription filter sends their otlp-stdout lines to the forwarder.
        otlpForwarder.addPermission("OtlpForwarderCwlPermission", {
          principal: new ServicePrincipal("logs.amazonaws.com"),
          action: "lambda:InvokeFunction",
          sourceArn: `arn:aws:logs:${this.region}:${this.account}:log-group:*`,
          sourceAccount: this.account,
        });

        const otlpAccountSubFilter = new CfnAccountPolicy(this, "OtlpAccountSubFilter", {
          policyName: "OtlpAccountSubFilter",
          policyDocument: JSON.stringify({
            DestinationArn: otlpForwarder.functionArn,
            FilterPattern: "{ $.__otel_otlp_stdout = * }",
            Distribution: "Random",
          }),
          policyType: "SUBSCRIPTION_FILTER_POLICY",
          scope: "ALL",
          selectionCriteria: `LogGroupName NOT IN ["${FORWARDER_LOG_GROUP}"]`,
        });
        // The filter can only be created once CloudWatch Logs may invoke the forwarder.
        otlpAccountSubFilter.node.addDependency(otlpForwarder);
        break;
      }
      case "event-bus": {
        // aws-cdk-lib models the AWS::EventsV2 resources from 2.272.0; until then they are
        // declared as plain CloudFormation resources.
        const eventBus = new CfnResource(this, "OtlpEventBus", {
          type: "AWS::EventsV2::EventBus",
          properties: {
            Name: EVENT_BUS_NAME,
            StorageConfiguration: { RetentionPeriodInDays: 1 },
          },
        });
        const eventBusArn = eventBus.getAtt("EventBusArn").toString();

        // Lets every account in the organization publish to the bus. The managed
        // permission grants nothing else, such as subscribing.
        new CfnResourceShare(this, "OtlpEventBusShare", {
          name: EVENT_BUS_NAME,
          resourceArns: [eventBusArn],
          principals: [orgArn],
          permissionArns: ["arn:aws:ram::aws:permission/AWSRAMEventBridgeEventBusV2PublishOnly"],
          allowExternalPrincipals: false,
        });

        const deadLetterQueue = new Queue(this, "OtlpSubscriberDlq", {
          queueName: "otlp-subscriber-dlq",
          retentionPeriod: Duration.days(14),
        });

        const subscriberRole = new Role(this, "OtlpSubscriberRole", {
          assumedBy: new ServicePrincipal("events.amazonaws.com"),
        });
        otlpForwarder.grantInvoke(subscriberRole);
        deadLetterQueue.grantSendMessages(subscriberRole);

        const subscriber = new CfnResource(this, "OtlpSubscriber", {
          type: "AWS::EventsV2::Subscriber",
          properties: {
            Name: FORWARDER_NAME,
            EventBusArn: eventBusArn,
            // EVENT hands each batch to Lambda's asynchronous queue, which absorbs
            // throttling when the forwarder runs out of concurrency. The bus then sees
            // only failures to queue, so the dead-letter queue holds events that never
            // reached the forwarder, not batches the forwarder failed to export.
            InvokeConfiguration: {
              TargetArn: otlpForwarder.functionArn,
              RoleArn: subscriberRole.roleArn,
              LambdaParameters: { InvocationType: "EVENT" },
            },
            // Matches the batches the Kinesis transport delivers.
            BatchConfiguration: { MaxBatchSize: 100, MaxBatchWindowInSeconds: 5 },
            OnFailureConfiguration: { Arn: deadLetterQueue.queueArn },
          },
        });
        // The resource types are newer than the validator that ships with aws-cdk-lib 2.270.
        for (const resource of [eventBus, subscriber]) {
          Validations.of(resource).acknowledge({
            id: "CloudFormation-Validate::F3006",
            reason:
              "AWS::EventsV2 is registered in CloudFormation but not yet known to this validator",
          });
        }
        // The role needs its policy before EventBridge validates the target.
        subscriber.node.addDependency(subscriberRole);

        new CfnOutput(this, "EventBusArn", {
          value: eventBusArn,
        });
        break;
      }
    }
  }
}
