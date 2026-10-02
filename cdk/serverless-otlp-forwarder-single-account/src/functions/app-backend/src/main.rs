use serde_dynamo::to_attribute_value;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    env,
    sync::{Arc, LazyLock},
};
use tracing::{Instrument, instrument};

use aws_lambda_events::event::apigw::ApiGatewayProxyRequest;
use aws_sdk_dynamodb::{Client as DynamoDbClient, types::AttributeValue};
use lambda_lw_http_router::{define_router, route};
use lambda_otel_lite::{TelemetryConfig, create_traced_handler, init_telemetry};
use lambda_runtime::{Error as LambdaError, LambdaEvent, Runtime, service_fn, tracing::field};
use opentelemetry::{Array, Value as OtelValue};
use tracing_opentelemetry::OpenTelemetrySpanExt;

/// Sets the attributes of a DynamoDB client span: the OpenTelemetry database and RPC
/// conventions, plus the `aws.remote.*` attributes that CloudWatch Application Signals
/// uses to show the table as a dependency. The region and provider are resource
/// attributes, so the spans do not repeat them.
fn set_dynamodb_span_attributes(
    span: &tracing::Span,
    table_name: &'static str,
    operation: &'static str,
) {
    span.record("otel.name", format!("DynamoDB.{operation}"));

    let region = env::var("AWS_REGION").unwrap_or_default();
    span.set_attribute("db.system", "dynamodb");
    span.set_attribute("db.operation", operation);
    span.set_attribute("server.address", format!("dynamodb.{region}.amazonaws.com"));
    span.set_attribute("server.port", 443);

    span.set_attribute("rpc.system", "aws-api");
    span.set_attribute("rpc.service", "DynamoDB");
    span.set_attribute("rpc.method", operation);
    let table_names = OtelValue::Array(Array::String(vec![table_name.to_string().into()]));
    span.set_attribute("aws.dynamodb.table_names", table_names);

    span.set_attribute("aws.remote.service", "AWS::DynamoDB");
    span.set_attribute("aws.remote.operation", operation);
    span.set_attribute("aws.remote.resource.type", "AWS::DynamoDB::Table");
    span.set_attribute("aws.remote.resource.identifier", table_name);
    span.set_attribute("aws.remote.resource.cfn.primary.identifier", table_name);
    span.set_attribute("aws.span.kind", "CLIENT");
}

/// Creates a DynamoDB span with standard attributes
macro_rules! dynamodb_span {
    ($table_name:expr, $operation:expr) => {{
        let span = tracing::info_span!(
            "dynamodb_operation",
            otel.name = field::Empty,
            otel.kind = "client"
        );
        set_dynamodb_span_attributes(&span, $table_name, $operation);
        span
    }};
}

static TABLE_NAME: LazyLock<String> =
    LazyLock::new(|| env::var("TABLE_NAME").expect("TABLE_NAME must be set"));

#[derive(Clone)]
struct AppState {
    dynamodb_client: DynamoDbClient,
}

define_router!(event = ApiGatewayProxyRequest, state = AppState);

#[route(path = "/quotes", method = "POST")]
async fn handle_post_quotes(ctx: RouteContext) -> Result<Value, LambdaError> {
    let timestamp = chrono::Utc::now().to_rfc3339();
    let post_body = match ctx.event.body.as_ref() {
        Some(body) => match serde_json::from_str(body) {
            Ok(parsed_body) => parsed_body,
            Err(e) => {
                return Ok(json!({
                    "statusCode": 400,
                    "headers": {"Content-Type": "application/json"},
                    "body": json!({
                        "error": "Invalid JSON in request body",
                        "details": e.to_string()
                    }).to_string()
                }));
            }
        },
        None => {
            return Ok(json!({
                "statusCode": 400,
                "headers": {"Content-Type": "application/json"},
                "body": json!({
                    "error": "Missing request body"
                }).to_string()
            }));
        }
    };

    let id = Sha256::digest(serde_json::to_string(&post_body)?)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();

    write_item(&id, &timestamp, &post_body, &ctx.state).await?;

    Ok(json!({
        "statusCode": 200,
        "headers": {"Content-Type": "application/json"},
        "body": serde_json::to_string(&json!({
            "message": "Item successfully written to DynamoDB",
            "received": post_body,
            "timestamp": timestamp
        }))?
    }))
}

#[route(path = "/quotes", method = "GET")]
async fn handle_get_quotes(ctx: RouteContext) -> Result<Value, LambdaError> {
    let items = list_items(&ctx.state).await?;
    Ok(json!({
        "statusCode": 200,
        "headers": {"Content-Type": "application/json"},
        "body": serde_json::to_string(&items)?
    }))
}

#[route(path = "/quotes/{id}", method = "GET")]
async fn handle_get_quote(ctx: RouteContext) -> Result<Value, LambdaError> {
    let id = ctx.params.get("id").expect("id parameter is required");
    let item = read_item(id, &ctx.state).await?;

    match item {
        Some(value) => Ok(json!({
            "statusCode": 200,
            "headers": {"Content-Type": "application/json"},
            "body": serde_json::to_string(&value)?
        })),
        None => Ok(json!({
            "statusCode": 404,
            "headers": {"Content-Type": "application/json"},
            "body": json!({"message": "Item not found"}).to_string()
        })),
    }
}

#[instrument(skip_all)]
async fn write_item(
    pk: &str,
    timestamp: &str,
    payload: &Option<Value>,
    state: &AppState,
) -> Result<(), LambdaError> {
    let mut request = state
        .dynamodb_client
        .put_item()
        .table_name(TABLE_NAME.clone())
        .item("pk", AttributeValue::S(pk.to_string()))
        .item(
            "expiry",
            AttributeValue::N((chrono::Utc::now().timestamp() + 86400).to_string()),
        )
        .item("timestamp", AttributeValue::S(timestamp.to_string()));

    if let Some(payload_value) = payload {
        let attribute_value = to_attribute_value(payload_value)
            .map_err(|e| LambdaError::from(format!("Failed to serialize payload: {}", e)))?;
        request = request.item("payload", attribute_value);
    }

    request
        .send()
        .instrument(dynamodb_span!(TABLE_NAME.as_str(), "PutItem"))
        .await
        .map(|_| ())
        .map_err(|e| LambdaError::from(format!("Failed to put item into DynamoDB: {}", e)))
}

#[instrument(skip(state))]
async fn read_item(pk: &str, state: &AppState) -> Result<Option<Value>, LambdaError> {
    let response = state
        .dynamodb_client
        .get_item()
        .table_name(TABLE_NAME.clone())
        .key("pk", AttributeValue::S(pk.to_string()))
        .send()
        .instrument(dynamodb_span!(TABLE_NAME.as_str(), "GetItem"))
        .await
        .map_err(|e| LambdaError::from(format!("Failed to get item from DynamoDB: {}", e)))?;

    if let Some(item) = response.item {
        serde_dynamo::from_item(item)
            .map_err(|e| LambdaError::from(format!("Failed to deserialize DynamoDB item: {}", e)))
            .map(Some)
    } else {
        tracing::info!(name = "item not found", pk = %pk, table = TABLE_NAME.as_str());
        Ok(None)
    }
}

#[instrument(skip(state))]
async fn list_items(state: &AppState) -> Result<Vec<Value>, LambdaError> {
    let scan_output = state
        .dynamodb_client
        .scan()
        .table_name(TABLE_NAME.clone())
        .send()
        .instrument(dynamodb_span!(TABLE_NAME.as_str(), "Scan"))
        .await
        .map_err(|e| LambdaError::from(format!("Failed to scan DynamoDB table: {}", e)))?;

    let items = scan_output
        .items
        .unwrap_or_default()
        .into_iter()
        .map(|item| {
            serde_dynamo::from_item(item).map_err(|e| {
                LambdaError::from(format!("Failed to deserialize DynamoDB item: {}", e))
            })
        })
        .collect::<Result<Vec<Value>, LambdaError>>()?;

    let item_count = items.len();
    tracing::info!(
        name = "retrieved items from dynamo",
        item_count = item_count,
        table = TABLE_NAME.as_str()
    );

    Ok(items)
}

#[tokio::main]
async fn main() -> Result<(), LambdaError> {
    // Initialize telemetry with default configuration
    let (_, completion_handler) = init_telemetry(TelemetryConfig::default()).await?;

    let aws_config = aws_config::load_from_env().await;
    let dynamodb_client = DynamoDbClient::new(&aws_config);

    let state = Arc::new(AppState { dynamodb_client });
    let router = Arc::new(RouterBuilder::from_registry().build());

    // Define the handler function
    async fn handler(
        event: LambdaEvent<ApiGatewayProxyRequest>,
        router: Arc<Router>,
        state: Arc<AppState>,
    ) -> Result<Value, LambdaError> {
        router.handle_request(event, state).await
    }

    // Create a traced handler with the captured router and state
    let traced_handler =
        create_traced_handler("backend-handler", completion_handler, move |event| {
            let router_clone = router.clone();
            let state_clone = state.clone();
            handler(event, router_clone, state_clone)
        });

    // Run the Lambda runtime with our traced handler
    Runtime::new(service_fn(traced_handler)).run().await
}
