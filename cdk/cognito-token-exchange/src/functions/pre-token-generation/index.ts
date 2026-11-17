import type { PreTokenGenerationV2TriggerHandler } from "aws-lambda";
import { ORDERS_RESOURCE_SERVER } from "../../constants.js";

// Grants every user both orders scopes at sign-in. A real app would decide per user, for example
// from their groups. Token exchange invokes this trigger too, and Cognito removes any scope added
// there that the exchange didn't request, so the agent still gets `orders/read` only.
export const handler: PreTokenGenerationV2TriggerHandler = async (event) => {
  event.response = {
    claimsAndScopeOverrideDetails: {
      accessTokenGeneration: {
        scopesToAdd: [`${ORDERS_RESOURCE_SERVER}/read`, `${ORDERS_RESOURCE_SERVER}/write`],
      },
    },
  };
  return event;
};
