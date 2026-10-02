import {
  TriggerType,
  createTracedHandler,
  defaultExtractor,
  initTelemetry,
} from "@dev7a/lambda-otel-lite";
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import type { Context as LambdaContext, ScheduledEvent } from "aws-lambda";
import { z } from "zod";
import { validateEnv } from "../../utils/validate-env.js";

//==============================================================================
// LAMBDA INITIALIZATION (COLD START)
//==============================================================================

// The service name comes from OTEL_SERVICE_NAME or AWS_LAMBDA_FUNCTION_NAME.
const { tracer, completionHandler } = initTelemetry();

// fetch runs on undici, so this traces every request and sends the trace context,
// which lets app-backend join this trace.
registerInstrumentations({
  tracerProvider: trace.getTracerProvider(),
  instrumentations: [new UndiciInstrumentation()],
});

const QUOTES_URL = "https://dummyjson.com/quotes/random";
const { TARGET_URL } = validateEnv(["TARGET_URL"]);

const QuoteSchema = z.object({
  id: z.number(),
  quote: z.string(),
  author: z.string(),
});
type Quote = z.infer<typeof QuoteSchema>;

//==============================================================================
// LAMBDA HANDLER
//==============================================================================

// A failed call throws out of the handler, and the traced handler records the
// exception on the invocation span and marks the span as failed.
async function lambdaHandler(_event: ScheduledEvent, _context: LambdaContext) {
  const quote = await getRandomQuote();
  await saveQuote(quote);
  trace.getActiveSpan()?.addEvent("Quote Saved", { "quote.id": quote.id });
  return { quote_id: quote.id };
}

// Names the invocation span and marks it as triggered by the schedule.
function scheduledEventExtractor(event: unknown, context: LambdaContext) {
  return {
    ...defaultExtractor(event, context),
    kind: SpanKind.SERVER,
    trigger: TriggerType.Timer,
    spanName: "generate-quotes",
  };
}

const traced = createTracedHandler<ScheduledEvent>(
  "quotes-function",
  completionHandler,
  scheduledEventExtractor,
);

export const handler = traced(lambdaHandler);

//==============================================================================
// HELPER FUNCTIONS
//==============================================================================

// Runs fn in a child span that fails, with the exception recorded, when fn throws.
async function inSpan<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    try {
      return await fn();
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

async function getRandomQuote(): Promise<Quote> {
  return inSpan("get_random_quote", async () => {
    const response = await fetch(QUOTES_URL);
    if (!response.ok) {
      throw new Error(`GET ${QUOTES_URL} failed with status ${response.status}`);
    }
    return QuoteSchema.parse(await response.json());
  });
}

async function saveQuote(quote: Quote): Promise<unknown> {
  return inSpan("save_quote", async () => {
    const response = await fetch(TARGET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(quote),
    });
    if (!response.ok) {
      throw new Error(`POST ${TARGET_URL} failed with status ${response.status}`);
    }
    return response.json();
  });
}
