import {
  DiagConsoleLogger,
  DiagLogLevel,
  SpanKind,
  SpanStatusCode,
  diag,
  trace,
} from "@opentelemetry/api";
import { type ExportResult, ExportResultCode, hrTimeToMicroseconds } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { awsLambdaDetector } from "@opentelemetry/resource-detector-aws";
import { detectResources, envDetector } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  ATTR_AWS_LAMBDA_INVOKED_ARN,
  ATTR_FAAS_COLDSTART,
  ATTR_FAAS_INVOCATION_ID,
} from "@opentelemetry/semantic-conventions/incubating";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from "aws-lambda";

// Cold start tracking
declare global {
  var __OTEL_LAMBDA_COLD_START_DONE__: boolean | undefined;
}

// Custom console exporter with JSON format
class CustomConsoleSpanExporter extends ConsoleSpanExporter {
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    for (const span of spans) {
      const spanJson = {
        attributes: span.attributes,
        duration: hrTimeToMicroseconds(span.duration),
        events: span.events,
        id: span.spanContext().spanId,
        instrumentationScope: span.instrumentationScope,
        kind: span.kind,
        links: span.links,
        name: span.name,
        parentSpanId: span.parentSpanContext?.spanId,
        resource: {
          attributes: span.resource.attributes,
        },
        status: span.status,
        timestamp: hrTimeToMicroseconds(span.startTime),
        traceId: span.spanContext().traceId,
        traceState: span.spanContext().traceState?.serialize(),
      };

      console.log(JSON.stringify(spanJson, null, 2));
    }
    resultCallback({ code: ExportResultCode.SUCCESS });
  }
}

// Enable debug logging (configurable via OTEL_LOG_LEVEL env var in production)
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);

// Initialize OpenTelemetry with resource detection
const provider = new NodeTracerProvider({
  resource: detectResources({
    detectors: [awsLambdaDetector, envDetector],
  }),
  spanProcessors: [
    new BatchSpanProcessor(
      new OTLPTraceExporter({
        url: "https://api.honeycomb.io/v1/traces",
        headers: {
          "x-honeycomb-team": process.env.HONEYCOMB_API_KEY || "",
        },
      }),
    ),
    new SimpleSpanProcessor(new CustomConsoleSpanExporter()),
  ],
});

// Register the provider
provider.register();

// Get a tracer
const tracer = trace.getTracer("lambda-tracer");

// Lambda handler function
export const handler = async (
  _event: APIGatewayProxyEventV2,
  context: Context,
): Promise<APIGatewayProxyResultV2> => {
  // Use function name as span name (per opentelemetry-lambda convention)
  // SpanKind.SERVER indicates this handles incoming requests
  return tracer.startActiveSpan(context.functionName, { kind: SpanKind.SERVER }, async (span) => {
    try {
      // Invocation-specific attributes not provided by awsLambdaDetector
      // (detector already sets: cloud.provider, cloud.platform, cloud.region,
      // faas.name, faas.version, faas.instance, faas.max_memory, aws.log.group.names)
      span.setAttributes({
        [ATTR_AWS_LAMBDA_INVOKED_ARN]: context.invokedFunctionArn,
        [ATTR_FAAS_COLDSTART]: !globalThis.__OTEL_LAMBDA_COLD_START_DONE__,
        [ATTR_FAAS_INVOCATION_ID]: context.awsRequestId,
      });
      globalThis.__OTEL_LAMBDA_COLD_START_DONE__ = true;

      // Your Lambda business logic
      const response: APIGatewayProxyResultV2 = {
        statusCode: 200,
        body: JSON.stringify({
          message: "Hello from Lambda!",
          requestId: context.awsRequestId,
        }),
      };

      // Set status to OK on successful completion
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();

      // Force flush before Lambda freezes
      await provider.forceFlush();
      return response;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      span.recordException(err);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err.message,
      });
      span.end();

      // Force flush before Lambda freezes
      await provider.forceFlush();
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Internal Server Error" }),
      };
    }
  });
};
