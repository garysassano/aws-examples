import { join } from "node:path";
import { CorsHttpMethod, HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { AppSyncAuthorizationType, Code, EventApi } from "aws-cdk-lib/aws-appsync";
import {
  Distribution,
  HttpVersion,
  PriceClass,
  ResponseHeadersPolicy,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { AttributeType, TableV2 } from "aws-cdk-lib/aws-dynamodb";
import { DockerImageAsset, Platform } from "aws-cdk-lib/aws-ecr-assets";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Architecture, LoggingFormat, Runtime } from "aws-cdk-lib/aws-lambda";
import { SqsDestination } from "aws-cdk-lib/aws-lambda-destinations";
import { type BundlingOptions, NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import { Bucket, EventType, HttpMethods } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, CacheControl, Source } from "aws-cdk-lib/aws-s3-deployment";
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
import type { Detector } from "../utils/detector.js";

export interface DetectLabelsStackProps extends StackProps {
  /** What detects the labels: Amazon Rekognition, or an open model on SageMaker. */
  detector: Detector;
}

// Minified ESM with the SDK inside: AWS recommends bundling the SDK rather than relying on the
// runtime's copy, and resolving each package's ESM build lets esbuild drop what isn't imported.
const bundling: BundlingOptions = {
  bundleAwsSDK: true,
  minify: true,
  format: OutputFormat.ESM,
  mainFields: ["module", "main"],
};

export class DetectLabelsStack extends Stack {
  constructor(scope: Construct, id: string, props: DetectLabelsStackProps) {
    super(scope, id, props);
    const { detector } = props;

    // Generate a unique ID for resource naming
    const uniqueId = this.node.addr.substring(0, 8);

    // S3 bucket for hosting the static website
    const websiteBucket = new Bucket(this, "WebsiteBucket", {
      bucketName: `website-bucket-${uniqueId}`,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // CloudFront distribution to serve the website from S3 bucket via OAC. The page only works
    // over HTTPS: the API's CORS allows the https origin, and crypto.randomUUID() needs a secure
    // page.
    const websiteDistribution = new Distribution(this, "WebsiteDistribution", {
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(websiteBucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: ResponseHeadersPolicy.SECURITY_HEADERS,
      },
      defaultRootObject: "index.html",
      httpVersion: HttpVersion.HTTP2_AND_3,
      priceClass: PriceClass.PRICE_CLASS_100,
    });
    const websiteOrigin = `https://${websiteDistribution.distributionDomainName}`;

    // S3 bucket for storing images to be processed by the detector
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
            // The longest an API key can last; redeploy before then to issue a new one.
            apiKeyConfig: { name: "SubscribeKey", expires: Expiration.after(Duration.days(365)) },
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
    const resultsNamespace = eventApi.addChannelNamespace("results", {
      authorizationConfig: {
        publishAuthModeTypes: [AppSyncAuthorizationType.IAM],
        subscribeAuthModeTypes: [AppSyncAuthorizationType.API_KEY],
      },
      code: Code.fromInline(`import { util } from '@aws-appsync/utils'

// APPSYNC_JS has no regular expression literals, so util.matches takes the pattern as a string.
const UPLOAD_ID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

export function onSubscribe(ctx) {
  const segments = ctx.info.channel.segments
  if (segments.length !== 2 || !util.matches(UPLOAD_ID, segments[1])) {
    util.unauthorized()
  }
}
`),
    });

    // Dead-letter queue for S3 events that the detect Lambda function fails to process
    const detectLabelsFailures = new Queue(this, "DetectLabelsFailures", {
      queueName: `detect-labels-failures-${uniqueId}`,
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // The detector-specific parts: the function's entry file, its timeout, and what it may call
    const { detectLabelsLambda, resultTimeout } =
      detector === "rekognition"
        ? this.rekognitionDetector(uniqueId, detectLabelsFailures)
        : this.sageMakerDetector(uniqueId, detectLabelsFailures, uploadsBucket);

    // Grant permissions to detect labels Lambda function. The idempotency utility only gets,
    // puts, updates, and deletes single items.
    idempotencyTable.grant(
      detectLabelsLambda,
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
    );
    uploadsBucket.grantRead(detectLabelsLambda, "uploads/*");
    resultsNamespace.grantPublish(detectLabelsLambda);
    detectLabelsLambda.addEnvironment("IDEMPOTENCY_TABLE_NAME", idempotencyTable.tableName);
    detectLabelsLambda.addEnvironment("EVENT_API_HTTP_DNS", eventApi.httpDns);

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
      bundling,
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
      createDefaultStage: false,
    });

    // The API is public, so cap how fast anyone can start uploads, and with them detections
    httpApi.addStage("DefaultStage", {
      stageName: "$default",
      autoDeploy: true,
      throttle: { rateLimit: 5, burstLimit: 10 },
    });

    // Add a route with Lambda integration
    httpApi.addRoutes({
      path: "/uploads",
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration("HttpApiLambdaIntegration", presignLambda),
    });

    // Deploy the built website to the S3 bucket. The hashed files under assets/ never change, so
    // browsers may keep them; old ones stay in the bucket, so a page cached before a deploy still
    // loads. The page and its config are revalidated on every load instead.
    const websiteDist = join(import.meta.dirname, "..", "website", "dist");
    const assetsDeployment = new BucketDeployment(this, "WebsiteAssetsDeployment", {
      sources: [Source.asset(websiteDist, { exclude: ["index.html"] })],
      destinationBucket: websiteBucket,
      prune: false,
      cacheControl: [CacheControl.fromString("public, max-age=31536000, immutable")],
    });
    const pageDeployment = new BucketDeployment(this, "WebsitePageDeployment", {
      sources: [
        Source.asset(websiteDist, { exclude: ["assets"] }),
        // The endpoints the site can't know at build time, and which detector it talks to
        Source.jsonData("config.json", {
          apiEndpointUrl: httpApi.apiEndpoint,
          eventApiHttpDns: eventApi.httpDns,
          eventApiRealtimeDns: eventApi.realtimeDns,
          eventApiKey: subscribeKey.attrApiKey,
          detector,
          resultTimeoutSeconds: resultTimeout.toSeconds(),
        }),
      ],
      destinationBucket: websiteBucket,
      prune: false,
      cacheControl: [CacheControl.noCache()],
      distribution: websiteDistribution,
      distributionPaths: ["/index.html", "/config.json"],
    });
    // The new page must not go live before the files it references.
    pageDeployment.node.addDependency(assetsDeployment);

    // Output the CloudFront distribution URL
    new CfnOutput(this, "WebsiteDistributionUrl", {
      value: websiteOrigin,
    });
  }

  /** The detect function for Amazon Rekognition, which needs nothing else in the stack. */
  private rekognitionDetector(uniqueId: string, failures: Queue) {
    const detectLabelsLambda = this.detectLabelsLambda(uniqueId, failures, {
      entry: "rekognition.ts",
      timeout: Duration.seconds(30),
    });
    detectLabelsLambda.addToRolePolicy(
      new PolicyStatement({
        actions: ["rekognition:DetectLabels"],
        resources: ["*"],
      }),
    );
    return { detectLabelsLambda, resultTimeout: Duration.minutes(1) };
  }

  /** A SageMaker Serverless Inference endpoint running D-FINE-L, and the detect function for it. */
  private sageMakerDetector(uniqueId: string, failures: Queue, uploadsBucket: Bucket) {
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

    const detectLabelsLambda = this.detectLabelsLambda(uniqueId, failures, {
      entry: "sagemaker.ts",
      // A request that starts a new endpoint container waits for it, which can take a while.
      timeout: Duration.minutes(2),
    });
    detectLabelsLambda.addEnvironment("ENDPOINT_NAME", endpoint.attrEndpointName);
    // A new image can detect differently, so it must not reuse the results cached for the old one.
    detectLabelsLambda.addEnvironment("MODEL_VERSION", modelImage.assetHash.slice(0, 12));
    detectLabelsLambda.addToRolePolicy(
      new PolicyStatement({
        actions: ["sagemaker:InvokeEndpoint"],
        resources: [endpoint.ref],
      }),
    );
    // The page waits for the function, plus the time the upload event takes to arrive.
    return { detectLabelsLambda, resultTimeout: Duration.minutes(2).plus(Duration.seconds(10)) };
  }

  /** Lambda function to detect labels in the images uploaded to the uploads bucket */
  private detectLabelsLambda(
    uniqueId: string,
    failures: Queue,
    options: { entry: string; timeout: Duration },
  ): NodejsFunction {
    return new NodejsFunction(this, "DetectLabelsLambda", {
      functionName: `detect-labels-lambda-${uniqueId}`,
      entry: join(import.meta.dirname, "..", "functions", "detect-labels", options.entry),
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: options.timeout,
      memorySize: 512,
      loggingFormat: LoggingFormat.JSON,
      retryAttempts: 1,
      // The page stops waiting after a couple of minutes, so a throttled event that is retried
      // later than this would only publish to nobody.
      maxEventAge: Duration.minutes(5),
      onFailure: new SqsDestination(failures),
      bundling,
    });
  }
}
