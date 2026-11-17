import {
  CognitoIdentityProviderClient,
  DescribeUserPoolClientCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import { ORDERS_RESOURCE_SERVER } from "../../constants.js";

const USER_POOL_ID = process.env.USER_POOL_ID as string;
const AGENT_CLIENT_ID = process.env.AGENT_CLIENT_ID as string;
const TOKEN_ENDPOINT = process.env.TOKEN_ENDPOINT as string;
const ORDERS_API_URL = process.env.ORDERS_API_URL as string;

const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

// Read the agent client's secret once per execution environment.
const cognito = new CognitoIdentityProviderClient();
const { UserPoolClient } = await cognito.send(
  new DescribeUserPoolClientCommand({ UserPoolId: USER_POOL_ID, ClientId: AGENT_CLIENT_ID }),
);
const basicAuth = Buffer.from(`${AGENT_CLIENT_ID}:${UserPoolClient?.ClientSecret}`).toString(
  "base64",
);

/** An error response from the token endpoint, such as `invalid_grant`. */
class TokenEndpointError extends Error {
  constructor(
    readonly grant: string,
    readonly body: { error?: string; error_description?: string },
  ) {
    super(`${grant} grant failed: ${body.error} ${body.error_description ?? ""}`.trim());
  }
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

// Both grants go to the token endpoint, authenticated as the agent client (client_secret_basic).
async function requestToken(params: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Basic ${basicAuth}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });
  const body = await response.json();
  if (!response.ok)
    throw new TokenEndpointError(params.grant_type, body as TokenEndpointError["body"]);
  return body as TokenResponse;
}

// The agent's own token, reused across requests until a minute before it expires.
let actor: { token: string; expiresAt: number } | undefined;

async function actorToken(): Promise<string> {
  if (!actor || Date.now() > actor.expiresAt) {
    const { access_token, expires_in } = await requestToken({ grant_type: "client_credentials" });
    actor = { token: access_token, expiresAt: Date.now() + (expires_in - 60) * 1000 };
  }
  return actor.token;
}

// For the response only: API Gateway verifies the token when the orders API receives it.
function decodeClaims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
}

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  // API Gateway has already verified the user's access token.
  const subjectToken = event.headers.authorization?.replace(/^Bearer /i, "") as string;

  // RFC 8693 delegation: with an actor token, the issued token names the user as `sub` and the
  // agent in `act`. It is bound to the orders audience and carries only the scopes that the
  // user's token, the request, and the agent client all allow.
  let exchanged: TokenResponse;
  try {
    exchanged = await requestToken({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: subjectToken,
      subject_token_type: ACCESS_TOKEN_TYPE,
      actor_token: await actorToken(),
      actor_token_type: ACCESS_TOKEN_TYPE,
      audience: ORDERS_RESOURCE_SERVER,
      scope: `${ORDERS_RESOURCE_SERVER}/read`,
    });
  } catch (error) {
    if (!(error instanceof TokenEndpointError)) throw error;
    console.error(error.message);
    return json(502, {
      error: "token_exchange_failed",
      grant: error.grant,
      tokenEndpoint: error.body,
    });
  }

  const orders = await fetch(`${ORDERS_API_URL}/orders`, {
    headers: { authorization: `Bearer ${exchanged.access_token}` },
  });

  const { sub, client_id, aud, scope, act, exp } = decodeClaims(exchanged.access_token);
  return json(orders.status, {
    exchangedToken: { sub, client_id, aud, scope, act, exp },
    ordersApi: await orders.json(),
  });
};
