import type { PreTokenGenerationV2TriggerHandler } from "aws-lambda";
import { ORDERS_RESOURCE_SERVER } from "../../constants.js";

// Grants every user both orders scopes at sign-in. A real app would decide per user, for example
// from their groups.
export const handler: PreTokenGenerationV2TriggerHandler = async (event) => {
  // Token exchange invokes this trigger too. Leave those tokens alone: an exchange can't add scopes,
  // and its requested scopes already decide what the issued token carries. `@types/aws-lambda`
  // doesn't list this trigger source yet, hence the cast.
  if ((event.triggerSource as string) === "TokenGeneration_TokenExchange") return event;

  event.response = {
    claimsAndScopeOverrideDetails: {
      accessTokenGeneration: {
        scopesToAdd: [`${ORDERS_RESOURCE_SERVER}/read`, `${ORDERS_RESOURCE_SERVER}/write`],
      },
    },
  };
  return event;
};
