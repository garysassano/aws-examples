import os

import requests
from lambda_otel_lite import create_traced_handler, init_telemetry
from opentelemetry import trace
from opentelemetry.instrumentation.requests import RequestsInstrumentor

# Initialize telemetry once at module load, then trace every requests call. The
# instrumentation also sends the trace context, so app-backend joins this trace.
tracer, completion_handler = init_telemetry()
RequestsInstrumentor().instrument()

http_session = requests.Session()
target_url = os.environ["TARGET_URL"]
quotes_url = "https://dummyjson.com/quotes/random"


@tracer.start_as_current_span("get_random_quote")
def get_random_quote():
    """Get a random quote from the API."""
    response = http_session.get(quotes_url)
    response.raise_for_status()
    return response.json()


@tracer.start_as_current_span("save_quote")
def save_quote(quote: dict):
    """Save the quote to app-backend."""
    response = http_session.post(target_url, json=quote)
    response.raise_for_status()
    return response.json()


traced = create_traced_handler(
    name="quotes-function",
    completion_handler=completion_handler,
)


@traced
def handler(event, context):
    """Fetches a random quote and saves it to app-backend.

    A failed call raises out of the handler, and the traced handler records the
    exception on the invocation span and marks the span as failed.
    """
    quote = get_random_quote()
    save_quote(quote)
    trace.get_current_span().add_event(
        "Quote Saved", attributes={"quote.id": quote["id"]}
    )
    return {"quote_id": quote["id"]}
