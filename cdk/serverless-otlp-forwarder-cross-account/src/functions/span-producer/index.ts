import {
  TriggerType,
  createTracedHandler,
  defaultExtractor,
  initTelemetry,
} from "@dev7a/lambda-otel-lite";
import { SpanKind } from "@opentelemetry/api";
import type { Context as LambdaContext, ScheduledEvent } from "aws-lambda";

// The spans go to stdout, or to the extension's pipe when the event bus transport
// sets OTLP_STDOUT_SPAN_EXPORTER_OUTPUT_TYPE=pipe.
const { tracer, completionHandler } = initTelemetry();

// Names the root span after the schedule that triggers the function.
function scheduledEventExtractor(event: unknown, context: LambdaContext) {
  return {
    ...defaultExtractor(event, context),
    kind: SpanKind.SERVER,
    trigger: TriggerType.Timer,
    spanName: "span-producer-schedule",
  };
}

const traced = createTracedHandler<ScheduledEvent>(
  "span-producer",
  completionHandler,
  scheduledEventExtractor,
);

export const handler = traced(async () => {
  // A child span, so each trace shows a parent and a child after crossing accounts.
  return tracer.startActiveSpan("say-hello", (span) => {
    const greeting = `Hello from ${process.env.AWS_LAMBDA_FUNCTION_NAME}`;
    span.setAttribute("greeting", greeting);
    span.end();
    return { greeting };
  });
});
