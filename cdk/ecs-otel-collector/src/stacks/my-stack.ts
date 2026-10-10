import { join } from "node:path";
import { Port, Vpc } from "aws-cdk-lib/aws-ec2";
import {
  Cluster,
  ContainerImage,
  Protocol as EcsProtocol,
  Secret as EcsSecret,
  FargateService,
  FargateTaskDefinition,
  LogDriver,
} from "aws-cdk-lib/aws-ecs";
import {
  ApplicationLoadBalancer,
  ApplicationProtocol,
  Protocol,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import {
  ManagedPolicy,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { Architecture, LayerVersion, LoggingFormat, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { RetentionDays } from "aws-cdk-lib/aws-logs";
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
    // VPC
    //==============================================================================

    const defaultVpc = Vpc.fromLookup(this, "DefaultVpc", { isDefault: true });

    //==============================================================================
    // ALB
    //==============================================================================

    const adotCollectorAlb = new ApplicationLoadBalancer(this, "AdotCollectorAlb", {
      vpc: defaultVpc,
      internetFacing: true,
    });

    const adotCollectorAlbOtlpListener = adotCollectorAlb.addListener(
      "AdotCollectorAlbOtlpListener",
      {
        port: 4318,
        protocol: ApplicationProtocol.HTTP,
      },
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

    // Role for pulling images from ECR
    const ecsTaskExecutionRole = new Role(this, "EcsTaskExecutionRole", {
      assumedBy: new ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonECSTaskExecutionRolePolicy"),
      ],
    });
    honeycombApiKeySecret.grantRead(ecsTaskExecutionRole);

    // Role to get confmap file from S3 bucket
    const ecsTaskRole = new Role(this, "EcsTaskRole", {
      assumedBy: new ServicePrincipal("ecs-tasks.amazonaws.com"),
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
    // ECS
    //==============================================================================

    const ecsCluster = new Cluster(this, "EcsCluster", {
      vpc: defaultVpc,
    });

    const fargateTaskDefinition = new FargateTaskDefinition(this, "FargateTaskDefinition", {
      cpu: 512,
      memoryLimitMiB: 1024,
      executionRole: ecsTaskExecutionRole,
      taskRole: ecsTaskRole,
    });

    fargateTaskDefinition.addContainer("adot-collector", {
      image: ContainerImage.fromRegistry(
        "public.ecr.aws/aws-observability/aws-otel-collector:latest",
      ),
      command: [
        "--config",
        `s3://${confmapBucket.bucketName}.s3.${this.region}.amazonaws.com/collector-confmap.yml`,
      ],
      secrets: {
        HONEYCOMB_API_KEY: EcsSecret.fromSecretsManager(honeycombApiKeySecret),
      },
      portMappings: [
        {
          containerPort: 4318,
          hostPort: 4318,
          protocol: EcsProtocol.TCP,
          name: "otlp",
        },
        {
          containerPort: 13133,
          hostPort: 13133,
          protocol: EcsProtocol.TCP,
          name: "healthcheck",
        },
      ],
      healthCheck: {
        command: ["CMD", "/healthcheck"],
        startPeriod: Duration.seconds(10),
      },
      logging: LogDriver.awsLogs({
        streamPrefix: "/ecs/adot-collector",
        logRetention: RetentionDays.ONE_WEEK,
      }),
    });

    const adotCollectorService = new FargateService(this, "AdotCollectorService", {
      cluster: ecsCluster,
      taskDefinition: fargateTaskDefinition,
      desiredCount: 2,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      assignPublicIp: true,
    });

    //==============================================================================
    // ALB TARGET GROUP
    //==============================================================================

    const otlpTarget = adotCollectorService.loadBalancerTarget({
      containerName: "adot-collector",
      containerPort: 4318,
      protocol: EcsProtocol.TCP,
    });

    adotCollectorAlbOtlpListener.addTargets("OtlpTarget", {
      port: 4318,
      protocol: ApplicationProtocol.HTTP,
      targets: [otlpTarget],
      healthCheck: {
        path: "/",
        port: "13133",
        protocol: Protocol.HTTP,
        healthyHttpCodes: "200",
      },
    });

    // Security Group Rules
    adotCollectorService.connections.allowFrom(
      adotCollectorAlb,
      Port.tcp(4318),
      "Allow ALB to access ADOT Collector OTLP endpoint",
    );
    adotCollectorService.connections.allowFrom(
      adotCollectorAlb,
      Port.tcp(13133),
      "Allow ALB to access ADOT Collector healthcheck endpoint",
    );

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
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://${adotCollectorAlb.loadBalancerDnsName}:4318/v1/traces`,
        OTEL_EXPORTER_OTLPPROTOCOL: "http/protobuf",
        OTEL_EXPORTER_OTLP_COMPRESSION: "gzip",
      },
    });

    new CfnOutput(this, "AdotHelloLambdaName", { value: adotHelloLambda.functionName });
  }
}
