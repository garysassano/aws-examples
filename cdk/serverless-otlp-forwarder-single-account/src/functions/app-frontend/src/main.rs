use aws_lambda_events::apigw::ApiGatewayV2httpRequest;
use chrono::{DateTime, Duration, FixedOffset, Utc};
use lambda_lw_http_router::{define_router, route};
use lambda_otel_lite::{TelemetryConfig, create_traced_handler, init_telemetry};
use lambda_runtime::{Error as LambdaError, Runtime, service_fn};
use reqwest::Client;
use reqwest_middleware::ClientBuilder;
use reqwest_middleware::ClientWithMiddleware;
use reqwest_tracing::TracingMiddleware;
use serde_json::{Value, json};
use std::env;
use std::sync::Arc;
use std::time::Duration as StdDuration;
use tera::{Context as TeraContext, Tera};
use thiserror::Error;
use tracing::instrument;

// Embed the quotes.html template at compile time
const QUOTES_TEMPLATE: &str = include_str!("templates/quotes.html");

#[derive(Clone)]
struct AppState {
    http_client: ClientWithMiddleware,
    target_url: String,
    templates: Tera,
}

define_router!(event = ApiGatewayV2httpRequest, state = AppState);

/// Loads the quotes template, with the values every page shows in the global context.
fn load_templates() -> Result<Tera, LambdaError> {
    let mut templates = Tera::new();
    templates
        .add_raw_template("quotes.html", QUOTES_TEMPLATE)
        .map_err(|e| format!("Failed to add template: {}", e))?;
    templates
        .global_context()
        .insert("app_name", "Quote Viewer");
    templates
        .global_context()
        .insert("version", env!("CARGO_PKG_VERSION"));
    Ok(templates)
}

/// Parses a quote's timestamp and adds a human-readable `relative_time` next to it.
fn add_relative_time(quote: &mut Value) -> Option<DateTime<FixedOffset>> {
    let timestamp = DateTime::parse_from_rfc3339(quote.get("timestamp")?.as_str()?).ok()?;
    let age = Utc::now().signed_duration_since(timestamp);
    let relative_time = if age.num_minutes() < 60 {
        format!("{} minutes ago", age.num_minutes())
    } else if age.num_hours() < 24 {
        format!("{} hours ago", age.num_hours())
    } else {
        format!("{} days ago", age.num_days())
    };
    quote
        .as_object_mut()?
        .insert("relative_time".to_string(), relative_time.into());
    Some(timestamp)
}

#[instrument(skip_all)]
async fn get_all_quotes(
    client: &ClientWithMiddleware,
    target_url: &str,
) -> Result<Value, LambdaError> {
    let target_url = format!("{}/quotes", target_url);

    // Use direct send() method instead of build() and execute() to allow middleware to inject headers
    let response = client
        .get(target_url.as_str())
        .send()
        .await
        .map_err(|e| format!("Failed to execute request: {}", e))?;

    // Handle non-success status codes
    if !response.status().is_success() {
        let status = response.status();
        let error_body = response
            .text()
            .await
            .unwrap_or_else(|_| "Unable to read error body".to_string());

        return Err(format!("HTTP error {}: {}", status, error_body).into());
    }

    response
        .json::<Value>()
        .await
        .map_err(|e| format!("Failed to parse response as JSON: {}", e).into())
}

#[derive(Debug, Error)]
enum QuoteError {
    #[error("Quote {0} not found")]
    NotFound(String),

    #[error("Backend error {0}: {1}")]
    BackendError(u16, String),

    #[error("Request error: {0}")]
    RequestError(String),
}

impl QuoteError {
    fn status_code(&self) -> u16 {
        match self {
            QuoteError::NotFound(_) => 404,
            QuoteError::BackendError(status, _) => *status,
            QuoteError::RequestError(_) => 500,
        }
    }
}

#[instrument(skip_all)]
async fn get_quote(
    client: &ClientWithMiddleware,
    target_url: &str,
    id: &str,
) -> Result<Value, QuoteError> {
    let target_url = format!("{}/quotes/{}", target_url, id);

    // Use direct send() method instead of build() and execute()
    let response = client
        .get(target_url.as_str())
        .send()
        .await
        .map_err(|e| QuoteError::RequestError(format!("Failed to execute request: {}", e)))?;

    match response.status() {
        status if status.is_success() => response.json::<Value>().await.map_err(|e| {
            QuoteError::RequestError(format!("Failed to parse response as JSON: {}", e))
        }),

        reqwest::StatusCode::NOT_FOUND => Err(QuoteError::NotFound(id.to_string())),

        status => {
            let error_body = response
                .text()
                .await
                .unwrap_or_else(|_| "Unable to read error body".to_string());

            Err(QuoteError::BackendError(status.as_u16(), error_body))
        }
    }
}

#[derive(Debug)]
struct TimeFrame {
    start: Duration,
    end: Duration,
    name: String,
}

impl TimeFrame {
    fn from_param(param: &str) -> Option<Self> {
        let (start, end) = match param {
            "now" => (Duration::zero(), Duration::hours(6)),
            "earlier" => (Duration::hours(6), Duration::hours(24)),
            "yesterday" => (Duration::hours(24), Duration::hours(48)),
            _ => return None,
        };

        Some(Self {
            start,
            end,
            name: param.to_string(),
        })
    }

    fn is_quote_in_range(&self, quote_time: DateTime<FixedOffset>) -> bool {
        let age = Utc::now().signed_duration_since(quote_time);
        age >= self.start && age < self.end
    }
}

#[route(method = "GET", path = "/")]
async fn handle_root_redirect(_rctx: RouteContext) -> Result<Value, LambdaError> {
    // Return a 301 permanent redirect to /now
    Ok(json!({
        "statusCode": 301,
        "headers": {
            "Location": "/now",
            "Content-Type": "text/html",
            "Cache-Control": "public, max-age=60"
        },
        "body": "<!DOCTYPE html><html><head><meta http-equiv=\"refresh\" content=\"0;url=/now\"></head><body>Redirecting to <a href=\"/now\">/now</a>...</body></html>"
    }))
}

#[route(method = "GET", path = "/{timeframe}")]
async fn handle_home(rctx: RouteContext) -> Result<Value, LambdaError> {
    // Parse and validate timeframe
    let timeframe = match rctx
        .params
        .get("timeframe")
        .and_then(|f| TimeFrame::from_param(f))
    {
        Some(frame) => {
            rctx.set_otel_attribute("resource.query.time_frame", frame.name.clone());
            frame
        }
        None => {
            return Ok(json!({
                "statusCode": 404,
                "headers": {
                    "Content-Type": "text/plain",
                    "Cache-Control": "public, max-age=60"
                },
                "body": "Invalid time frame"
            }));
        }
    };

    // Fetch and process quotes
    let quotes = get_and_process_quotes(&rctx, &timeframe).await?;

    // Render template
    let mut tera_ctx = TeraContext::new();
    tera_ctx.insert("quotes", &quotes);
    tera_ctx.insert("timeframe", &timeframe.name);

    let html_content = rctx
        .state
        .templates
        .render("quotes.html", &tera_ctx)
        .map_err(|e| format!("Template rendering error: {}", e))?;

    Ok(html_response(200, html_content))
}

/// Returns the quotes within the time frame, newest first.
async fn get_and_process_quotes(
    rctx: &RouteContext,
    timeframe: &TimeFrame,
) -> Result<Vec<Value>, LambdaError> {
    let response = get_all_quotes(&rctx.state.http_client, &rctx.state.target_url).await?;

    let Value::Array(quotes) = response else {
        return Ok(Vec::new());
    };

    let mut quotes = quotes
        .into_iter()
        .filter_map(|mut quote| Some((add_relative_time(&mut quote)?, quote)))
        .filter(|(timestamp, _)| timeframe.is_quote_in_range(*timestamp))
        .collect::<Vec<_>>();
    quotes.sort_by(|(a, _), (b, _)| b.cmp(a));

    Ok(quotes.into_iter().map(|(_, quote)| quote).collect())
}

/// Renders the page for a single quote, or an error message instead.
fn render_quotes_template(
    templates: &Tera,
    quotes: Vec<Value>,
    error_message: Option<&str>,
) -> Result<String, LambdaError> {
    let mut ctx = TeraContext::new();
    ctx.insert("quotes", &quotes);
    ctx.insert("single_quote", &true);

    if let Some(msg) = error_message {
        ctx.insert("error_message", msg);
    }

    templates
        .render("quotes.html", &ctx)
        .map_err(|e| format!("Template rendering error: {}", e).into())
}

/// Helper function to create an HTML response with the given status code
fn html_response(status_code: u16, html_content: String) -> Value {
    json!({
        "statusCode": status_code,
        "headers": {
            "Content-Type": "text/html",
            "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate"
        },
        "body": html_content
    })
}

#[route(method = "GET", path = "/quote/{id}")]
async fn handle_quote(rctx: RouteContext) -> Result<Value, LambdaError> {
    let quote_id = match rctx.params.get("id") {
        Some(id) if !id.is_empty() => {
            rctx.set_otel_attribute("resource.type", "quote")
                .set_otel_attribute("resource.path.quote_id", id.to_owned());
            id
        }
        _ => {
            let html_content = render_quotes_template(
                &rctx.state.templates,
                vec![],
                Some("Quote ID not provided"),
            )?;

            return Ok(html_response(404, html_content));
        }
    };

    match get_quote(&rctx.state.http_client, &rctx.state.target_url, quote_id).await {
        Ok(mut quote) => {
            add_relative_time(&mut quote);
            let html_content = render_quotes_template(&rctx.state.templates, vec![quote], None)?;

            Ok(html_response(200, html_content))
        }
        Err(err) => {
            let html_content =
                render_quotes_template(&rctx.state.templates, vec![], Some(&err.to_string()))?;

            Ok(html_response(err.status_code(), html_content))
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), LambdaError> {
    // Initialize telemetry with default configuration
    let (_, completion_handler) = init_telemetry(TelemetryConfig::default()).await?;

    let target_url =
        env::var("TARGET_URL").map_err(|_| "TARGET_URL environment variable must be set")?;

    // Initialize application state
    let state = Arc::new(AppState {
        http_client: {
            let reqwest_client = Client::builder()
                .timeout(StdDuration::from_secs(30))
                .user_agent("Quote-Viewer/1.0")
                .build()
                .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

            ClientBuilder::new(reqwest_client)
                .with(TracingMiddleware::default())
                .build()
        },
        target_url,
        templates: load_templates()?,
    });

    // Initialize router
    let router = Arc::new(RouterBuilder::from_registry().build());

    // Create a traced handler with the captured router and state
    let traced_handler =
        create_traced_handler("frontend-handler", completion_handler, move |event| {
            let (router, state) = (router.clone(), state.clone());
            async move { router.handle_request(event, state).await }
        });

    // Run the Lambda runtime with our traced handler
    Runtime::new(service_fn(traced_handler)).run().await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quote(timestamp: &str) -> Value {
        json!({
            "pk": "abc123",
            "timestamp": timestamp,
            "payload": {"quote": "Stay hungry, <stay> foolish.", "author": "Steve Jobs"}
        })
    }

    #[test]
    fn renders_the_quote_list() {
        let mut quote = quote(&Utc::now().to_rfc3339());
        assert!(add_relative_time(&mut quote).is_some());

        let mut ctx = TeraContext::new();
        ctx.insert("quotes", &vec![quote]);
        ctx.insert("timeframe", "now");
        let html = load_templates()
            .unwrap()
            .render("quotes.html", &ctx)
            .unwrap();

        assert!(html.contains("<title>Quote Viewer - v1.0.0</title>"));
        assert!(html.contains("Stay hungry, &lt;stay&gt; foolish."));
        assert!(html.contains("0 minutes ago"));
        assert!(html.contains(r#"href="/quote/abc123""#));
        assert!(html.contains(r#"class="nav-button current">Last 6 Hours"#));
    }

    #[test]
    fn renders_a_single_quote_and_errors() {
        let templates = load_templates().unwrap();

        let mut quote = quote("2020-01-01T00:00:00Z");
        add_relative_time(&mut quote);
        let html = render_quotes_template(&templates, vec![quote], None).unwrap();
        assert!(html.contains("Back to all quotes"));
        assert!(html.contains("days ago"));
        assert!(!html.contains("View quote"));

        let error = QuoteError::NotFound("abc123".to_string());
        let html = render_quotes_template(&templates, vec![], Some(&error.to_string())).unwrap();
        assert!(html.contains("Quote abc123 not found"));
        assert_eq!(error.status_code(), 404);
    }
}
