import { join } from "node:path";
import { type CfnStage, CorsHttpMethod, HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { AppSyncAuthorizationType, Code, EventApi } from "aws-cdk-lib/aws-appsync";
import { Distribution, PriceClass } from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { AttributeType, TableV2 } from "aws-cdk-lib/aws-dynamodb";
import { DockerImageAsset, Platform } from "aws-cdk-lib/aws-ecr-assets";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Architecture, LoggingFormat, Runtime } from "aws-cdk-lib/aws-lambda";
import { SqsDestination } from "aws-cdk-lib/aws-lambda-destinations";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import { Bucket, EventType, HttpMethods } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import { LambdaDestination } from "aws-cdk-lib/aws-s3-notifications";
import { CfnEndpoint, CfnEndpointConfig, CfnModel } from "aws-cdk-lib/aws-sagemaker";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import {
  CfnOutput,
  Duration,
  Expiration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from "aws-cdk-lib/core";
import type { Construct } from "constructs";

export class MyStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    // Generate a unique ID for resource naming
    const uniqueId = this.node.addr.substring(0, 8);

    // S3 bucket for hosting the static website
    const websiteBucket = new Bucket(this, "WebsiteBucket", {
      bucketName: `website-bucket-${uniqueId}`,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // CloudFront distribution to serve the website from S3 bucket via OAC
    const websiteDistribution = new Distribution(this, "WebsiteDistribution", {
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(websiteBucket),
      },
      defaultRootObject: "index.html",
      priceClass: PriceClass.PRICE_CLASS_100,
    });
    const websiteOrigin = `https://${websiteDistribution.distributionDomainName}`;

    // S3 bucket for storing images to be processed by the SageMaker endpoint
    const uploadsBucket = new Bucket(this, "UploadsBucket", {
      bucketName: `uploads-bucket-${uniqueId}`,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      cors: [
        {
          allowedOrigins: [websiteOrigin],
          allowedMethods: [HttpMethods.POST],
          allowedHeaders: ["*"],
          maxAge: 300,
        },
      ],
      // The detection result is delivered when the upload is processed, so the image itself
      // is not needed afterwards.
      lifecycleRules: [{ prefix: "uploads/", expiration: Duration.days(1) }],
    });

    // DynamoDB table that caches each image's detection by its ETag
    const idempotencyTable = new TableV2(this, "IdempotencyTable", {
      tableName: `idempotency-table-${uniqueId}`,
      partitionKey: {
        name: "id",
        type: AttributeType.STRING,
      },
      timeToLiveAttribute: "expiration",
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // AppSync Events API that pushes each detection result to the browser that uploaded the image.
    // Only the detect Lambda function can publish (IAM), and the browser can only subscribe
    // (API key).
    const eventApi = new EventApi(this, "EventApi", {
      apiName: `event-api-${uniqueId}`,
      authorizationConfig: {
        authProviders: [
          {
            authorizationType: AppSyncAuthorizationType.API_KEY,
            apiKeyConfig: { name: "SubscribeKey", expires: Expiration.after(Duration.days(30)) },
          },
          { authorizationType: AppSyncAuthorizationType.IAM },
        ],
        connectionAuthModeTypes: [AppSyncAuthorizationType.API_KEY],
        defaultPublishAuthModeTypes: [AppSyncAuthorizationType.IAM],
        defaultSubscribeAuthModeTypes: [AppSyncAuthorizationType.API_KEY],
      },
    });
    const subscribeKey = eventApi.apiKeys.SubscribeKey;

    // The API key is public, so the unguessable upload ID in the channel name is what keeps a
    // result private. This handler only lets a client subscribe to one exact `/results/<uploadId>`
    // channel, never to a wildcard that would receive everyone's results.
    eventApi.addChannelNamespace("results", {
      authorizationConfig: {
        publishAuthModeTypes: [AppSyncAuthorizationType.IAM],
        subscribeAuthModeTypes: [AppSyncAuthorizationType.API_KEY],
      },
      code: Code.fromInline(`import { util } from '@aws-appsync/utils'

export function onSubscribe(ctx) {
  const parts = ctx.info.channel.path.split('/').filter((part) => part.length > 0)
  if (parts.length !== 2 || parts[1].length !== 36 || parts[1].includes('*')) {
    util.unauthorized()
  }
}
`),
    });

    // Container image with the D-FINE-L weights and a small inference server
    const modelImage = new DockerImageAsset(this, "ModelImage", {
      directory: join(import.meta.dirname, "..", "model"),
      platform: Platform.LINUX_AMD64,
      // SageMaker only accepts Docker v2 manifests, but Docker's containerd image store pushes OCI
      // ones by default. This needs BuildKit's default attestations off, which the deploy script
      // does with BUILDX_NO_DEFAULT_ATTESTATIONS=1.
      outputs: ["type=image,oci-mediatypes=false"],
    });

    // Role that SageMaker uses to pull the image, read uploads, and write the container's logs
    const endpointName = `detect-labels-${uniqueId}`;
    const modelRole = new Role(this, "ModelRole", {
      assumedBy: new ServicePrincipal("sagemaker.amazonaws.com"),
    });
    modelImage.repository.grantPull(modelRole);
    uploadsBucket.grantRead(modelRole, "uploads/*");

    // SageMaker writes the container's output here. Creating the log group in the stack deletes it
    // with the stack, and the role gets no logs:CreateLogGroup, so nothing recreates it afterwards.
    const endpointLogGroup = new LogGroup(this, "EndpointLogGroup", {
      logGroupName: `/aws/sagemaker/Endpoints/${endpointName}`,
    });
    endpointLogGroup.grant(
      modelRole,
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogStreams",
    );

    // SageMaker model from the image
    const model = new CfnModel(this, "Model", {
      executionRoleArn: modelRole.roleArn,
      primaryContainer: { image: modelImage.imageUri },
    });
    // SageMaker checks the role's permissions while it creates the model.
    model.node.addDependency(modelRole);

    // Serverless Inference: no instances to choose or pay for while idle. Requests are billed by the
    // millisecond at the memory size, which also sets the vCPUs (6 GB is the most available).
    const endpointConfig = new CfnEndpointConfig(this, "EndpointConfig", {
      productionVariants: [
        {
          variantName: "AllTraffic",
          modelName: model.attrModelName,
          serverlessConfig: { memorySizeInMb: 6144, maxConcurrency: 5 },
        },
      ],
    });

    const endpoint = new CfnEndpoint(this, "Endpoint", {
      endpointName,
      endpointConfigName: endpointConfig.attrEndpointConfigName,
    });
    endpoint.node.addDependency(endpointLogGroup);

    // Dead-letter queue for S3 events that the detect Lambda function fails to process
    const detectLabelsFailures = new Queue(this, "DetectLabelsFailures", {
      queueName: `detect-labels-failures-${uniqueId}`,
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Lambda function to detect labels in the images uploaded to the uploads bucket
    const detectLabelsLambda = new NodejsFunction(this, "DetectLabelsLambda", {
      functionName: `detect-labels-lambda-${uniqueId}`,
      entry: join(import.meta.dirname, "..", "functions", "detect-labels", "index.ts"),
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      // A request that starts a new endpoint container waits for it, which can take a while.
      timeout: Duration.minutes(2),
      memorySize: 512,
      loggingFormat: LoggingFormat.JSON,
      retryAttempts: 1,
      onFailure: new SqsDestination(detectLabelsFailures),
      // By default the @smithy/* packages stay out of the bundle and the runtime lacks the
      // signing ones this function imports, so bundle the SDK with the code.
      bundling: { bundleAwsSDK: true },
      environment: {
        IDEMPOTENCY_TABLE_NAME: idempotencyTable.tableName,
        EVENT_API_HTTP_DNS: eventApi.httpDns,
        ENDPOINT_NAME: endpoint.attrEndpointName,
      },
    });

    // Grant permissions to detect labels Lambda function
    idempotencyTable.grantReadWriteData(detectLabelsLambda);
    uploadsBucket.grantRead(detectLabelsLambda, "uploads/*");
    eventApi.grantPublish(detectLabelsLambda);
    detectLabelsLambda.addToRolePolicy(
      new PolicyStatement({
        actions: ["sagemaker:InvokeEndpoint"],
        resources: [endpoint.ref],
      }),
    );

    // Trigger Lambda function on object upload to S3
    uploadsBucket.addEventNotification(
      EventType.OBJECT_CREATED,
      new LambdaDestination(detectLabelsLambda),
      { prefix: "uploads/" },
    );

    // Lambda function to sign upload forms for the uploads bucket
    const presignLambda = new NodejsFunction(this, "PresignLambda", {
      functionName: `presign-lambda-${uniqueId}`,
      entry: join(import.meta.dirname, "..", "functions", "presign", "index.ts"),
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(10),
      memorySize: 256,
      loggingFormat: LoggingFormat.JSON,
      environment: {
        UPLOADS_BUCKET_NAME: uploadsBucket.bucketName,
      },
    });

    // Grant permissions to presign Lambda function
    uploadsBucket.grantPut(presignLambda, "uploads/*");

    // Create an HTTP API with CORS enabled
    const httpApi = new HttpApi(this, "HttpApi", {
      apiName: `http-api-${uniqueId}`,
      corsPreflight: {
        allowOrigins: [websiteOrigin],
        allowMethods: [CorsHttpMethod.POST],
        allowHeaders: ["Content-Type"],
        maxAge: Duration.minutes(5),
      },
    });

    // The API is public, so cap how fast anyone can start uploads (and endpoint invocations)
    (httpApi.defaultStage?.node.defaultChild as CfnStage).defaultRouteSettings = {
      throttlingBurstLimit: 10,
      throttlingRateLimit: 5,
    };

    // Add a route with Lambda integration
    httpApi.addRoutes({
      path: "/uploads",
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration("HttpApiLambdaIntegration", presignLambda),
    });

    // Deploy the built website to the S3 bucket, with the endpoints it can't know at build time
    new BucketDeployment(this, "WebsiteBucketDeployment", {
      sources: [
        Source.asset(join(import.meta.dirname, "..", "website", "dist")),
        Source.jsonData("config.json", {
          apiEndpointUrl: httpApi.apiEndpoint,
          eventApiHttpDns: eventApi.httpDns,
          eventApiRealtimeDns: eventApi.realtimeDns,
          eventApiKey: subscribeKey.attrApiKey,
        }),
      ],
      destinationBucket: websiteBucket,
      distribution: websiteDistribution,
      distributionPaths: ["/index.html", "/config.json"],
    });

    // Output the CloudFront distribution URL
    new CfnOutput(this, "WebsiteDistributionUrl", {
      value: websiteOrigin,
    });
  }
}
