use aws_lambda_events::encodings::Body;
use aws_lambda_events::event::apigw::{ApiGatewayV2httpRequest, ApiGatewayV2httpResponse};
use lambda_otel_lite::{OtelTracingLayer, TelemetryConfig, init_telemetry};
use lambda_runtime::{Error, LambdaEvent, Runtime, tower::ServiceBuilder};
use opentelemetry::trace::Status;
use std::borrow::Cow;
use std::fmt::{self, Display};
use tracing::instrument;
use tracing_opentelemetry::OpenTelemetrySpanExt;

#[derive(Debug)]
enum ErrorType {
    Expected,
    Unexpected,
}

impl Display for ErrorType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}

/// A nested function with its own span, which fails at random on `/error`.
#[instrument(skip(event), level = "info", err)]
async fn nested_function(event: &ApiGatewayV2httpRequest) -> Result<String, ErrorType> {
    tracing::event!(
        name: "example.info",
        tracing::Level::INFO,
        "event.body" = "Nested function called",
        "event.severity_text" = "info",
        "event.severity_number" = 9
    );

    if event.raw_path.as_deref() == Some("/error") {
        let r: f64 = rand::random();
        if r < 0.25 {
            return Err(ErrorType::Expected);
        } else if r < 0.5 {
            return Err(ErrorType::Unexpected);
        }
    }

    Ok("success".to_string())
}

/// Builds a Function URL response with the given status code and body.
fn response(status_code: i64, body: impl Into<Body>) -> ApiGatewayV2httpResponse {
    let mut response = ApiGatewayV2httpResponse::default();
    response.status_code = status_code;
    response.body = Some(body.into());
    response
}

/// Records the request as a span event, then answers 200, or on `/error` sometimes 400
/// for an expected error or a failed invocation for an unexpected one.
async fn handler(
    event: LambdaEvent<ApiGatewayV2httpRequest>,
) -> Result<ApiGatewayV2httpResponse, Error> {
    let request_id = &event.context.request_id;
    let current_span = tracing::Span::current();

    tracing::event!(
        name: "example.info",
        tracing::Level::INFO,
        "event.body" = serde_json::to_string(&event.payload).unwrap_or_default(),
        "event.severity_text" = "info",
        "event.severity_number" = 9
    );

    match nested_function(&event.payload).await {
        Ok(_) => Ok(response(200, format!("Hello from request {request_id}"))),
        Err(ErrorType::Expected) => {
            // A client error: lambda-otel-lite fails a span only on a 5xx response or an
            // error, so this one keeps an OK status.
            tracing::event!(
              name:"example.error",
              tracing::Level::ERROR,
              "event.body" = "This is an expected error",
              "event.severity_text" = "error",
              "event.severity_number" = 17,
            );
            Ok(response(400, r#"{"message": "This is an expected error"}"#))
        }
        Err(ErrorType::Unexpected) => {
            tracing::event!(
              name:"example.error",
              tracing::Level::ERROR,
              "event.body" = "This is an unexpected error",
              "event.severity_text" = "error",
              "event.severity_number" = 17,
            );
            current_span.set_status(Status::Error {
                description: Cow::Borrowed("Unexpected error occurred"),
            });
            Err(Error::from("Unexpected error occurred"))
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    let (_, completion_handler) = init_telemetry(TelemetryConfig::default()).await?;

    // The tower layer is the alternative to create_traced_handler that app-backend uses.
    let service = ServiceBuilder::new()
        .layer(OtelTracingLayer::new(completion_handler).with_name("tower-handler"))
        .service_fn(handler);

    Runtime::new(service).run().await
}
