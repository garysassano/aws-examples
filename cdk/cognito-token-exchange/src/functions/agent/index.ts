import {
  CognitoIdentityProviderClient,
  DescribeUserPoolClientCommand,
  GetDerivedTokenCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import { ORDERS_RESOURCE_SERVER } from "../../constants.js";

const USER_POOL_ID = process.env.USER_POOL_ID as string;
const AGENT_CLIENT_ID = process.env.AGENT_CLIENT_ID as string;
const TOKEN_ENDPOINT = process.env.TOKEN_ENDPOINT as string;
const ORDERS_API_URL = process.env.ORDERS_API_URL as string;

// Read the agent client's secret once per execution environment.
const cognito = new CognitoIdentityProviderClient();
const { UserPoolClient } = await cognito.send(
  new DescribeUserPoolClientCommand({ UserPoolId: USER_POOL_ID, ClientId: AGENT_CLIENT_ID }),
);
const clientSecret = UserPoolClient?.ClientSecret as string;

// The agent's own access token from a client credentials grant, reused across requests until a
// minute before it expires.
let actor: { token: string; expiresAt: number } | undefined;

async function actorToken(): Promise<string> {
  if (!actor || Date.now() > actor.expiresAt) {
    const response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${AGENT_CLIENT_ID}:${clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(`Token endpoint returned ${response.status}: ${JSON.stringify(body)}`);
    }
    const { access_token, expires_in } = body as { access_token: string; expires_in: number };
    actor = { token: access_token, expiresAt: Date.now() + (expires_in - 60) * 1000 };
  }
  return actor.token;
}

// For the response only: API Gateway verifies the token when the orders API receives it.
function decodeClaims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  // API Gateway has already verified the user's access token.
  const subjectToken = event.headers.authorization?.replace(/^Bearer /i, "") as string;

  // Delegation: with an actor token, the issued token names the user as `sub` and the agent in
  // `act`. It is bound to the orders audience and carries only the scopes that the user's token,
  // the request, and the agent client all allow.
  const { IssuedToken } = await cognito.send(
    new GetDerivedTokenCommand({
      ClientId: AGENT_CLIENT_ID,
      ClientSecret: clientSecret,
      SubjectToken: subjectToken,
      SubjectTokenType: "ACCESS_TOKEN",
      ActorToken: await actorToken(),
      ActorTokenType: "ACCESS_TOKEN",
      Audiences: [ORDERS_RESOURCE_SERVER],
      Scopes: [`${ORDERS_RESOURCE_SERVER}/read`],
    }),
  );
  const exchangedToken = IssuedToken as string;

  const orders = await fetch(`${ORDERS_API_URL}/orders`, {
    headers: { authorization: `Bearer ${exchangedToken}` },
  });

  const { sub, client_id, aud, scope, act, exp } = decodeClaims(exchangedToken);
  return {
    statusCode: orders.status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      exchangedToken: { sub, client_id, aud, scope, act, exp },
      ordersApi: await orders.json(),
    }),
  };
};
