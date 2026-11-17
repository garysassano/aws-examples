export const REGION = "eu-central-1";
export const STACK_NAME = "cdk-cognito-token-exchange-dev";

// Identifier of the resource server that the orders API stands for. Exchanged tokens carry it as
// their `aud` claim, and its scopes are `orders/read` and `orders/write`.
export const ORDERS_RESOURCE_SERVER = "orders";
