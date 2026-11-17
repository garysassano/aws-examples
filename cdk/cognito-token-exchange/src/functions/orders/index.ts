import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";

const ORDERS = [
  { id: "ord-1001", item: "Coffee beans", quantity: 2 },
  { id: "ord-1002", item: "Grinder", quantity: 1 },
];

// API Gateway has already checked the token's signature, issuer, audience, and scope.
export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  // API Gateway flattens nested claims such as `act` into strings, so read them from the token.
  const token = event.headers.authorization?.replace(/^Bearer /i, "") as string;
  const { sub, act } = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      // Whose orders these are, and which client is acting for them, if any
      user: sub,
      actor: act?.sub ?? null,
      orders: ORDERS,
    }),
  };
};
