import { join } from "node:path";
import { Code, EventApi, type HandlerConfig, LambdaInvokeType } from "aws-cdk-lib/aws-appsync";
import { AttributeType, TableV2 } from "aws-cdk-lib/aws-dynamodb";
import { Architecture, LoggingFormat, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib/core";
import type { Construct } from "constructs";

export class MyStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    // Lambda function that handles the events of the `lambda` namespace
    const eventsFunction = new NodejsFunction(this, "EventsFunction", {
      functionName: "events-function",
      entry: join(import.meta.dirname, "../functions/events", "index.ts"),
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(10),
      loggingFormat: LoggingFormat.JSON,
    });

    // DynamoDB table that stores the events of the `dynamodb` namespace. The handler in
    // `src/handlers/dynamodb-namespace.js` repeats this table name.
    const eventsTable = new TableV2(this, "EventsTable", {
      tableName: "events-table",
      partitionKey: {
        name: "id",
        type: AttributeType.STRING,
      },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // AppSync Events API, authorized with an API key
    const eventsApi = new EventApi(this, "EventsApi", {
      apiName: "events-api",
    });
    const lambdaDataSource = eventsApi.addLambdaDataSource("LambdaDataSource", eventsFunction);
    const dynamoDbDataSource = eventsApi.addDynamoDbDataSource("DynamoDbDataSource", eventsTable);

    // Namespace that calls the Lambda function directly, with no handler code in AppSync
    const lambdaHandlerConfig: HandlerConfig = {
      dataSource: lambdaDataSource,
      direct: true,
      lambdaInvokeType: LambdaInvokeType.REQUEST_RESPONSE,
    };
    eventsApi.addChannelNamespace("lambda", {
      publishHandlerConfig: lambdaHandlerConfig,
      subscribeHandlerConfig: lambdaHandlerConfig,
    });

    // Namespace whose APPSYNC_JS handler writes to the DynamoDB table
    eventsApi.addChannelNamespace("dynamodb", {
      code: Code.fromAsset(join(import.meta.dirname, "../handlers", "dynamodb-namespace.js")),
      publishHandlerConfig: { dataSource: dynamoDbDataSource },
      subscribeHandlerConfig: { dataSource: dynamoDbDataSource },
    });
  }
}
