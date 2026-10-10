import { join } from "node:path";
import { Secret as ApprunnerSecret, Service, Source } from "@aws-cdk/aws-apprunner-alpha";
import { PolicyDocument, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Architecture, LayerVersion, LoggingFormat, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source as S3Source } from "aws-cdk-lib/aws-s3-deployment";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib/core";
import type { Construct } from "constructs";
import { adotNodeLayerArn } from "../utils/adot-node-layer.js";

// Created before deployment, so the API key never appears in the template.
const honeycombApiKeySecretName: string = "honeycomb-api-key";

export class MyStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    //==============================================================================
    // SECRETS MANAGER
    //==============================================================================

    const honeycombApiKeySecret = Secret.fromSecretNameV2(
      this,
      "HoneycombApiKeySecret",
      honeycombApiKeySecretName,
    );

    //==============================================================================
    // S3
    //==============================================================================

    const confmapBucket = new Bucket(this, "ConfmapBucket", {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    new BucketDeployment(this, "DeployConfmap", {
      sources: [S3Source.asset(join(import.meta.dirname, "../otel"))],
      destinationBucket: confmapBucket,
    });

    //==============================================================================
    // IAM
    //==============================================================================

    // Role to get confmap file from S3 bucket
    const apprunnerInstanceRole = new Role(this, "ApprunnerInstanceRole", {
      assumedBy: new ServicePrincipal("tasks.apprunner.amazonaws.com"),
      inlinePolicies: {
        S3Access: new PolicyDocument({
          statements: [
            new PolicyStatement({
              actions: ["s3:GetObject"],
              resources: [confmapBucket.arnForObjects("*")],
            }),
          ],
        }),
      },
    });

    //==============================================================================
    // APP RUNNER
    //==============================================================================

    const adotCollectorService = new Service(this, "AdotCollectorService", {
      instanceRole: apprunnerInstanceRole,
      source: Source.fromEcrPublic({
        imageIdentifier: "public.ecr.aws/aws-observability/aws-otel-collector:latest",
        imageConfiguration: {
          port: 4318,
          startCommand: `--config s3://${confmapBucket.bucketName}.s3.${this.region}.amazonaws.com/collector-confmap.yml`,
          environmentSecrets: {
            HONEYCOMB_API_KEY: ApprunnerSecret.fromSecretsManager(honeycombApiKeySecret),
          },
        },
      }),
    });

    //==============================================================================
    // LAMBDA
    //==============================================================================

    const adotNodeLayer = LayerVersion.fromLayerVersionArn(
      this,
      "AdotNodeLayer",
      adotNodeLayerArn(this),
    );

    // No fixed name, so this app and its App Runner or ECS counterpart can share an account.
    const adotHelloLambda = new NodejsFunction(this, "AdotHelloLambda", {
      entry: join(import.meta.dirname, "../functions/hello", "index.ts"),
      layers: [adotNodeLayer],
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.minutes(1),
      loggingFormat: LoggingFormat.JSON,
      environment: {
        // ADOT SDK - Lambda Extension
        AWS_LAMBDA_EXEC_WRAPPER: "/opt/otel-instrument",
        OTEL_AWS_APPLICATION_SIGNALS_ENABLED: "false",
        // ADOT SDK - General
        OTEL_SERVICE_NAME: "adot-hello-lambda",
        OTEL_PROPAGATORS: "tracecontext",
        OTEL_TRACES_EXPORTER: "otlp",
        // ADOT SDK - OTLP Exporter
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `https://${adotCollectorService.serviceUrl}/v1/traces`,
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
        OTEL_EXPORTER_OTLP_COMPRESSION: "gzip",
      },
    });

    new CfnOutput(this, "AdotHelloLambdaName", { value: adotHelloLambda.functionName });
  }
}
