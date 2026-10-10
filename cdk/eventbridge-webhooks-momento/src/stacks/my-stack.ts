import {
  CloudwatchLogsLogDestination,
  Filter,
  FilterPattern,
  IncludeExecutionData,
  InputTransformation,
  LogLevel,
  Pipe,
} from "@aws-cdk/aws-pipes-alpha";
import { DynamoDBSource, DynamoDBStartingPosition } from "@aws-cdk/aws-pipes-sources-alpha";
import { ApiDestinationTarget } from "@aws-cdk/aws-pipes-targets-alpha";
import { AttributeType, StreamViewType, TableV2 } from "aws-cdk-lib/aws-dynamodb";
import { ApiDestination, Authorization, Connection, HttpMethod } from "aws-cdk-lib/aws-events";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { Duration, RemovalPolicy, SecretValue, Stack, type StackProps } from "aws-cdk-lib/core";
import type { Construct } from "constructs";
import { validateEnv } from "../utils/validate-env.js";

const cacheName: string = "momento-eventbridge-cache";
const topicName: string = "momento-eventbridge-topic";
// Created before deployment, so the API key never appears in the template.
const apiKeySecretName: string = "momento-api-key";

const env = validateEnv(["MOMENTO_API_ENDPOINT"]);

export class MyStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    //==============================================================================
    // DYNAMODB
    //==============================================================================

    const weatherStatsTable = new TableV2(this, "WeatherStatsTable", {
      tableName: "weather-stats-table",
      partitionKey: {
        name: "Location",
        type: AttributeType.STRING,
      },
      timeToLiveAttribute: "TTL",
      dynamoStream: StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    //==============================================================================
    // SQS
    //==============================================================================

    const weatherStatsTableDlq = new Queue(this, "WeatherStatsTableDlq", {
      queueName: "weather-stats-table-dlq",
      retentionPeriod: Duration.days(14),
    });

    //==============================================================================
    // CLOUDWATCH
    //==============================================================================

    const logGroup = new LogGroup(this, "AccessLogs", {
      retention: RetentionDays.THREE_MONTHS,
      logGroupName: `weather-stats-demo-logs-${this.region}`,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const logDestination = new CloudwatchLogsLogDestination(logGroup);

    //==============================================================================
    // EVENTBRIDGE
    //==============================================================================

    //------------------------------------------------------------------------------
    // Connections
    //------------------------------------------------------------------------------
    const momentoConnection = new Connection(this, "MomentoConnection", {
      connectionName: "momento-connection",
      authorization: Authorization.apiKey(
        "Authorization",
        SecretValue.secretsManager(apiKeySecretName),
      ),
    });

    //------------------------------------------------------------------------------
    // API Destinations
    //------------------------------------------------------------------------------
    const momentoCachePutApiDestination = new ApiDestination(
      this,
      "MomentoCachePutApiDestination",
      {
        apiDestinationName: "momento-cache-put-api-destination",
        connection: momentoConnection,
        endpoint: `${env.MOMENTO_API_ENDPOINT}/cache/*`,
        httpMethod: HttpMethod.PUT,
      },
    );

    const momentoCacheDeleteApiDestination = new ApiDestination(
      this,
      "MomentoCacheDeleteApiDestination",
      {
        apiDestinationName: "momento-cache-delete-api-destination",
        connection: momentoConnection,
        endpoint: `${env.MOMENTO_API_ENDPOINT}/cache/*`,
        httpMethod: HttpMethod.DELETE,
      },
    );

    const momentoTopicsPostApiDestination = new ApiDestination(
      this,
      "MomentoTopicsPostApiDestination",
      {
        apiDestinationName: "momento-topics-post-api-destination",
        connection: momentoConnection,
        endpoint: `${env.MOMENTO_API_ENDPOINT}/topics/*/*`,
        httpMethod: HttpMethod.POST,
      },
    );

    //------------------------------------------------------------------------------
    // Pipes
    //------------------------------------------------------------------------------
    const commonPipeSourceConfig = {
      startingPosition: DynamoDBStartingPosition.LATEST,
      batchSize: 1,
      maximumRetryAttempts: 0,
      deadLetterTarget: weatherStatsTableDlq,
    };

    const commonPipeConfig = {
      logDestinations: [logDestination],
      logLevel: LogLevel.INFO,
      logIncludeExecutionData: [IncludeExecutionData.ALL],
    };

    // Momento Cache Put Pipe
    new Pipe(this, "MomentoCachePutPipe", {
      pipeName: "momento-cache-put-pipe",
      source: new DynamoDBSource(weatherStatsTable, commonPipeSourceConfig),
      filter: new Filter([FilterPattern.fromObject({ eventName: ["INSERT", "MODIFY"] })]),
      target: new ApiDestinationTarget(momentoCachePutApiDestination, {
        pathParameterValues: [cacheName],
        queryStringParameters: {
          key: "$.dynamodb.Keys.Location.S",
          // TTL holds the epoch time for DynamoDB TTL; Momento wants seconds from now.
          ttl_seconds: "$.dynamodb.NewImage.TtlSeconds.N",
        },
        inputTransformation: InputTransformation.fromObject({
          Location: "<$.dynamodb.Keys.Location.S>",
          MaxTemp: "<$.dynamodb.NewImage.MaxTemp.N>",
          MinTemp: "<$.dynamodb.NewImage.MinTemp.N>",
          ChancesOfPrecipitation: "<$.dynamodb.NewImage.ChancesOfPrecipitation.N>",
        }),
      }),
      ...commonPipeConfig,
    });

    // Momento Cache Delete Pipe
    new Pipe(this, "MomentoCacheDeletePipe", {
      pipeName: "momento-cache-delete-pipe",
      source: new DynamoDBSource(weatherStatsTable, commonPipeSourceConfig),
      filter: new Filter([FilterPattern.fromObject({ eventName: ["REMOVE"] })]),
      target: new ApiDestinationTarget(momentoCacheDeleteApiDestination, {
        pathParameterValues: [cacheName],
        queryStringParameters: {
          key: "$.dynamodb.Keys.Location.S",
        },
      }),
      ...commonPipeConfig,
    });

    // Momento Topics Post Pipe
    new Pipe(this, "MomentoTopicsPostPipe", {
      pipeName: "momento-topics-post-pipe",
      source: new DynamoDBSource(weatherStatsTable, commonPipeSourceConfig),
      target: new ApiDestinationTarget(momentoTopicsPostApiDestination, {
        pathParameterValues: [cacheName, topicName],
        inputTransformation: InputTransformation.fromObject({
          EventType: "<$.eventName>",
          Location: "<$.dynamodb.Keys.Location.S>",
          MaxTemp: "<$.dynamodb.NewImage.MaxTemp.N>",
          MinTemp: "<$.dynamodb.NewImage.MinTemp.N>",
          ChancesOfPrecipitation: "<$.dynamodb.NewImage.ChancesOfPrecipitation.N>",
        }),
      }),
      ...commonPipeConfig,
    });
  }
}
