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

    //==============================================================================
    // SAMPLE FUNCTION (LAMBDA)
    //==============================================================================

    const sampleFunction = new NodejsFunction(this, `SampleFunction`, {
      functionName: "sample-function",
      entry: join(import.meta.dirname, "../functions/sample", "index.ts"),
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.minutes(1),
      loggingFormat: LoggingFormat.JSON,
    });

    //==============================================================================
    // SAMPLE TABLE (DDB)
    //==============================================================================

    const sampleTable = new TableV2(this, "SampleTable", {
      tableName: "sample-table",
      partitionKey: {
        name: "id",
        type: AttributeType.STRING,
      },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    //==============================================================================
    // SAMPLE API (APPSYNC EVENTS)
    //==============================================================================

    // Sample API
    const sampleApi = new EventApi(this, "SampleApi", {
      apiName: "sample-api",
    });

    // Sample API Data Sources
    const sampleApiLambdaDs = sampleApi.addLambdaDataSource("SampleApiLambdaDs", sampleFunction);
    const sampleApiDdbDs = sampleApi.addDynamoDbDataSource("SampleApiDdbDs", sampleTable);

    // Lambda Channel Namespace
    const sampleApiLambdaHandlerConfig: HandlerConfig = {
      dataSource: sampleApiLambdaDs,
      direct: true,
      lambdaInvokeType: LambdaInvokeType.REQUEST_RESPONSE,
    };
    sampleApi.addChannelNamespace("foo", {
      publishHandlerConfig: sampleApiLambdaHandlerConfig,
      subscribeHandlerConfig: sampleApiLambdaHandlerConfig,
    });

    // DDB Channel Namespace
    sampleApi.addChannelNamespace("bar", {
      code: Code.fromInline(`import * as ddb from '@aws-appsync/utils/dynamodb'
import { util } from '@aws-appsync/utils'

const TABLE = '${sampleTable.tableName}'

export const onPublish = {
  request(ctx) {
    const channel = ctx.info.channel.path
    const timestamp = util.time.nowISO8601()
    return ddb.batchPut({
      tables: {
        [TABLE]: ctx.events.map(({id, payload}) => ({
          channel, id, timestamp, ...payload,
        })),
      },
    })
  },
  response(ctx) {
    if (ctx.result && ctx.result.data && ctx.result.data[TABLE]) {
      return ctx.result.data[TABLE].map(({ id, ...payload }) => ({ id, payload }))
    } else {
      console.log('Unexpected response structure or missing data for table:', TABLE, JSON.stringify(ctx.result))
      return []
    }
  },
}

export const onSubscribe = {
  request(ctx) {
    const channel = ctx.info.channel.path
    const timestamp = util.time.nowISO8601()
    const id = util.autoId()
    return ddb.batchPut({
      tables: {
        [TABLE]: [{
          channel, id, timestamp
        }],
      },
    })
  },
  response(ctx) {
    return null
  },
}
`),
      publishHandlerConfig: {
        dataSource: sampleApiDdbDs,
      },
      subscribeHandlerConfig: {
        dataSource: sampleApiDdbDs,
      },
    });
  }
}
