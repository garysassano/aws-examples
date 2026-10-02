import { join } from "node:path";
import { EndpointType, LambdaIntegration, RestApi } from "aws-cdk-lib/aws-apigateway";
import { AttributeType, TableV2 } from "aws-cdk-lib/aws-dynamodb";
import { ManagedPolicy, PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Stream } from "aws-cdk-lib/aws-kinesis";
import {
  ApplicationLogLevel,
  Architecture,
  FunctionUrlAuthType,
  Function as LambdaFunction,
  LayerVersion,
  LoggingFormat,
  Runtime,
  StartingPosition,
  SystemLogLevel,
} from "aws-cdk-lib/aws-lambda";
import { KinesisEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { CfnAccountPolicy } from "aws-cdk-lib/aws-logs";
import { Schedule, ScheduleExpression } from "aws-cdk-lib/aws-scheduler";
import { LambdaInvoke } from "aws-cdk-lib/aws-scheduler-targets";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import {
  Aspects,
  CfnOutput,
  DockerImage,
  Duration,
  type IAspect,
  RemovalPolicy,
  SecretValue,
  Stack,
  type StackProps,
} from "aws-cdk-lib/core";
import { RustExtension, RustFunction } from "cargo-lambda-cdk";
import type { Construct, IConstruct } from "constructs";
import { PythonFunction } from "uv-python-lambda";
import { getExporter } from "../utils/exporter.js";
import { getTransport } from "../utils/transport.js";
import { validateEnv } from "../utils/validate-env.js";

// ROTel Lambda extension v0.1.6 (rotel v0.2.4). Every supported region publishes this
// layer version; see https://github.com/rotel-dev/rotel-lambda-extension/releases.
const ROTEL_EXTENSION_LAYER_VERSION = 7;

export class MyStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    const exporter = getExporter(this.node.tryGetContext("exporter"));
    const transport = getTransport(this.node.tryGetContext("transport"));

    //==============================================================================
    // QUOTES TABLE (DDB)
    //==============================================================================

    const quotesTable = new TableV2(this, "QuotesTable", {
      tableName: "quotes-table",
      partitionKey: { name: "pk", type: AttributeType.STRING },
      timeToLiveAttribute: "expiry",
      removalPolicy: RemovalPolicy.DESTROY,
    });

    //==============================================================================
    // BACKEND API (APIGW)
    //==============================================================================

    const backendApi = new RestApi(this, "BackendApi", {
      restApiName: "backend-api",
      endpointTypes: [EndpointType.REGIONAL],
    });
    backendApi.node.tryRemoveChild("Endpoint");

    //==============================================================================
    // APP FUNCTIONS (LAMBDA)
    //==============================================================================

    // App Backend Function
    const appBackend = new RustFunction(this, "AppBackend", {
      functionName: "app-backend",
      manifestPath: join(import.meta.dirname, "../functions/app-backend", "Cargo.toml"),
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.minutes(1),
      loggingFormat: LoggingFormat.JSON,
      bundling: { cargoLambdaFlags: ["--quiet"] },
      environment: {
        TABLE_NAME: quotesTable.tableName,
      },
    });
    quotesTable.grantReadWriteData(appBackend);

    // App Frontend Function
    const appFrontend = new RustFunction(this, "AppFrontend", {
      functionName: "app-frontend",
      manifestPath: join(import.meta.dirname, "../functions/app-frontend", "Cargo.toml"),
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.minutes(1),
      loggingFormat: LoggingFormat.JSON,
      bundling: { cargoLambdaFlags: ["--quiet"] },
      environment: {
        LAMBDA_EXTENSION_SPAN_PROCESSOR_MODE: "async",
        TARGET_URL: backendApi.url,
      },
    });
    const appFrontendUrl = appFrontend.addFunctionUrl({
      authType: FunctionUrlAuthType.NONE,
    });

    //==============================================================================
    // BACKEND API ROUTES (APIGW)
    //==============================================================================

    // {api}/quotes
    const quotesResource = backendApi.root.resourceForPath("/quotes");
    quotesResource.addMethod("GET", new LambdaIntegration(appBackend));
    quotesResource.addMethod("POST", new LambdaIntegration(appBackend));

    // {api}/quotes/{id}
    const quoteByIdResource = backendApi.root.resourceForPath("/quotes/{id}");
    quoteByIdResource.addMethod("GET", new LambdaIntegration(appBackend));

    //==============================================================================
    // CLIENT FUNCTIONS (LAMBDA)
    //==============================================================================

    // Client Node Function
    const clientNode = new NodejsFunction(this, "ClientNode", {
      functionName: "client-node",
      entry: join(import.meta.dirname, "../functions/client-node", "index.ts"),
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.minutes(1),
      loggingFormat: LoggingFormat.JSON,
      environment: {
        LAMBDA_EXTENSION_SPAN_PROCESSOR_MODE: "async",
        TARGET_URL: `${backendApi.url}quotes`,
      },
    });
    new Schedule(this, "ClientNodeSchedule", {
      scheduleName: "client-node-schedule",
      description: `Trigger ${clientNode.functionName} every 5 minutes`,
      schedule: ScheduleExpression.rate(Duration.minutes(5)),
      target: new LambdaInvoke(clientNode),
    });

    // Client Python Function
    // The bundling image takes its Python version from the function's runtime,
    // so dependencies are always built for the interpreter Lambda runs.
    const clientPythonRuntime = Runtime.PYTHON_3_14;
    const clientPython = new PythonFunction(this, "ClientPython", {
      functionName: "client-python",
      rootDir: join(import.meta.dirname, "../functions/client-python"),
      runtime: clientPythonRuntime,
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.minutes(1),
      loggingFormat: LoggingFormat.JSON,
      bundling: {
        image: DockerImage.fromBuild(join(import.meta.dirname, "../functions/client-python"), {
          buildArgs: { PYTHON_VERSION: clientPythonRuntime.name.replace("python", "") },
        }),
        assetExcludes: ["Dockerfile", ".venv"],
      },
      environment: {
        LAMBDA_EXTENSION_SPAN_PROCESSOR_MODE: "async",
        TARGET_URL: `${backendApi.url}quotes`,
      },
    });
    new Schedule(this, "ClientPythonSchedule", {
      scheduleName: "client-python-schedule",
      description: `Trigger ${clientPython.functionName} every 5 minutes`,
      schedule: ScheduleExpression.rate(Duration.minutes(5)),
      target: new LambdaInvoke(clientPython),
    });

    // Client Rust Function
    const clientRust = new RustFunction(this, "ClientRust", {
      functionName: "client-rust",
      manifestPath: join(import.meta.dirname, "../functions/client-rust", "Cargo.toml"),
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.minutes(1),
      loggingFormat: LoggingFormat.JSON,
      bundling: { cargoLambdaFlags: ["--quiet"] },
      environment: {
        LAMBDA_EXTENSION_SPAN_PROCESSOR_MODE: "async",
      },
    });
    const clientRustUrl = clientRust.addFunctionUrl({
      authType: FunctionUrlAuthType.NONE,
    });

    // Client Rust Wide Function
    const clientRustWide = new RustFunction(this, "ClientRustWide", {
      functionName: "client-rust-wide",
      manifestPath: join(import.meta.dirname, "../functions/client-rust-wide", "Cargo.toml"),
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.minutes(1),
      loggingFormat: LoggingFormat.JSON,
      bundling: { cargoLambdaFlags: ["--quiet"] },
      environment: {
        LAMBDA_EXTENSION_SPAN_PROCESSOR_MODE: "async",
      },
    });
    const clientRustWideUrl = clientRustWide.addFunctionUrl({
      authType: FunctionUrlAuthType.NONE,
    });

    //==============================================================================
    // OTLP FORWARDER (LAMBDA)
    //==============================================================================

    const otlpForwarder = new RustFunction(this, "OtlpForwarder", {
      functionName: "otlp-forwarder",
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
        // OTel SDK
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
      },
    });

    //==============================================================================
    // OTLP EXPORTER
    //==============================================================================

    if (exporter === "cloudwatch") {
      // The forwarder signs its requests with SigV4, which the CloudWatch OTLP endpoint
      // requires, and the spans land in this account's Transaction Search.
      otlpForwarder.addEnvironment(
        "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
        `https://xray.${this.region}.amazonaws.com/v1/traces`,
      );
      otlpForwarder.addEnvironment("OTLP_SIGV4_SERVICE", "xray");
      otlpForwarder.role?.addManagedPolicy(
        ManagedPolicy.fromAwsManagedPolicyName("AWSXrayWriteOnlyAccess"),
      );
    } else if (exporter === "otlp") {
      // The forwarder sends the spans, and its own, to the OTLP endpoint.
      const env = validateEnv(["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_HEADERS"]);
      otlpForwarder.addEnvironment("OTEL_EXPORTER_OTLP_ENDPOINT", env.OTEL_EXPORTER_OTLP_ENDPOINT);
      otlpForwarder.addEnvironment("OTEL_EXPORTER_OTLP_HEADERS", env.OTEL_EXPORTER_OTLP_HEADERS);
    } else {
      // The forwarder sends the spans, and its own, to the ROTel Lambda extension,
      // which exports them to ClickHouse together with the forwarder's logs.
      const env = validateEnv([
        "CLICKHOUSE_ENDPOINT",
        "CLICKHOUSE_DATABASE",
        "CLICKHOUSE_USERNAME",
        "CLICKHOUSE_PASSWORD",
      ]);
      const clickHouseConfig = new Secret(this, "ClickHouseConfig", {
        secretName: "clickhouse-config",
        description: "ClickHouse connection settings for the ROTel Lambda extension",
        secretObjectValue: {
          endpoint: SecretValue.unsafePlainText(env.CLICKHOUSE_ENDPOINT),
          database: SecretValue.unsafePlainText(env.CLICKHOUSE_DATABASE),
          user: SecretValue.unsafePlainText(env.CLICKHOUSE_USERNAME),
          password: SecretValue.unsafePlainText(env.CLICKHOUSE_PASSWORD),
        },
      });

      otlpForwarder.addLayers(
        LayerVersion.fromLayerVersionArn(
          this,
          "RotelExtension",
          `arn:aws:lambda:${this.region}:418653438961:layer:rotel-extension-arm64:${ROTEL_EXTENSION_LAYER_VERSION}`,
        ),
      );
      otlpForwarder.addEnvironment("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318");
      otlpForwarder.addEnvironment("ROTEL_EXPORTER", "clickhouse");
      otlpForwarder.addEnvironment(
        "ROTEL_CLICKHOUSE_EXPORTER_ENDPOINT",
        `secret://${clickHouseConfig.secretArn}#endpoint`,
      );
      otlpForwarder.addEnvironment(
        "ROTEL_CLICKHOUSE_EXPORTER_DATABASE",
        `secret://${clickHouseConfig.secretArn}#database`,
      );
      otlpForwarder.addEnvironment(
        "ROTEL_CLICKHOUSE_EXPORTER_USER",
        `secret://${clickHouseConfig.secretArn}#user`,
      );
      otlpForwarder.addEnvironment(
        "ROTEL_CLICKHOUSE_EXPORTER_PASSWORD",
        `secret://${clickHouseConfig.secretArn}#password`,
      );

      // ROTel resolves the secret at cold start with BatchGetSecretValue, which only
      // returns the secrets the role may read with GetSecretValue.
      clickHouseConfig.grantRead(otlpForwarder);
      otlpForwarder.addToRolePolicy(
        new PolicyStatement({
          actions: ["secretsmanager:BatchGetSecretValue"],
          resources: ["*"],
        }),
      );
    }

    //==============================================================================
    // OTLP TRANSPORT
    //==============================================================================

    switch (transport) {
      case "logs-subscription": {
        // CloudWatch Logs may invoke the forwarder for any log group in this account.
        otlpForwarder.addPermission("OtlpForwarderCwlPermission", {
          principal: new ServicePrincipal("logs.amazonaws.com"),
          action: "lambda:InvokeFunction",
          sourceArn: `arn:aws:logs:${this.region}:${this.account}:log-group:*`,
          sourceAccount: this.account,
        });

        // Sends every otlp-stdout line in the account to the forwarder, except the
        // forwarder's own, which would otherwise loop back to it.
        const otlpForwarderAccountSubFilter = new CfnAccountPolicy(
          this,
          "OtlpForwarderAccountSubFilter",
          {
            policyName: "OtlpForwarderAccountSubFilter",
            policyDocument: JSON.stringify({
              DestinationArn: otlpForwarder.functionArn,
              FilterPattern: "{ $.__otel_otlp_stdout = * }",
              Distribution: "Random",
            }),
            policyType: "SUBSCRIPTION_FILTER_POLICY",
            scope: "ALL",
            selectionCriteria: `LogGroupName NOT IN ["/aws/lambda/${otlpForwarder.functionName}"]`,
          },
        );
        // The filter can only be created once CloudWatch Logs may invoke the forwarder.
        otlpForwarderAccountSubFilter.node.addDependency(otlpForwarder);
        break;
      }
      case "kinesis": {
        const otlpStream = new Stream(this, "OtlpStream", {
          streamName: "otlp-stream",
          shardCount: 1,
          retentionPeriod: Duration.days(1),
          removalPolicy: RemovalPolicy.DESTROY,
        });

        otlpForwarder.addEventSource(
          new KinesisEventSource(otlpStream, {
            startingPosition: StartingPosition.LATEST,
            batchSize: 100,
            maxBatchingWindow: Duration.seconds(5),
          }),
        );

        const otlpStdoutKinesisExtension = new RustExtension(this, "OtlpStdoutKinesisExtension", {
          layerVersionName: "otlp-stdout-kinesis-extension",
          manifestPath: join(
            import.meta.dirname,
            "../layers/otlp-stdout-kinesis-extension",
            "Cargo.toml",
          ),
          architecture: Architecture.ARM_64,
          bundling: { cargoLambdaFlags: ["--quiet"] },
        });

        Aspects.of(this).add(
          new ApplyKinesisExtensionAspect(otlpStream, otlpStdoutKinesisExtension, otlpForwarder),
        );
        break;
      }
    }

    //==============================================================================
    // OUTPUTS
    //==============================================================================

    new CfnOutput(this, "QuotesApiUrl", {
      value: `${backendApi.url}quotes`,
    });

    new CfnOutput(this, "AppFrontendUrl", {
      value: appFrontendUrl.url,
    });

    new CfnOutput(this, "ClientRustUrl", {
      value: clientRustUrl.url,
    });

    new CfnOutput(this, "ClientRustWideUrl", {
      value: clientRustWideUrl.url,
    });
  }
}

//==============================================================================
// CDK ASPECTS
//==============================================================================

// Attaches the extension to every function except the forwarder: the forwarder's own
// spans and platform telemetry would otherwise loop back to it through the stream.
class ApplyKinesisExtensionAspect implements IAspect {
  constructor(
    private readonly kinesisStream: Stream,
    private readonly extensionLayer: LayerVersion,
    private readonly forwarder: LambdaFunction,
  ) {}

  public visit(node: IConstruct): void {
    if (node instanceof LambdaFunction && node !== this.forwarder) {
      node.addLayers(this.extensionLayer);
      if (node.role) {
        this.kinesisStream.grantWrite(node.role);
      }
      node.addEnvironment("OTEL_LITE_EXTENSION_STREAM_NAME", this.kinesisStream.streamName);
      node.addEnvironment("OTEL_LITE_EXTENSION_ENABLE_PLATFORM_TELEMETRY", "true");
      // The spans go to the extension through a pipe instead of the function's stdout.
      node.addEnvironment("OTLP_STDOUT_SPAN_EXPORTER_OUTPUT_TYPE", "pipe");
    }
  }
}
