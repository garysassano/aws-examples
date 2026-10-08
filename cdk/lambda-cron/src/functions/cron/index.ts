import { Logger } from "@aws-lambda-powertools/logger";
import { injectLambdaContext } from "@aws-lambda-powertools/logger/middleware";
import middy from "@middy/core";
import httpErrorHandler from "@middy/http-error-handler";
import type { ScheduledHandler } from "aws-lambda";

const logger = new Logger();

const lambdaHandler: ScheduledHandler = async () => {
  const response = {
    statusCode: 200,
    body: "Hello from Lambda!",
  };

  console.log(response);
};

export const handler = middy(lambdaHandler)
  .use(injectLambdaContext(logger, { logEvent: true }))
  .use(httpErrorHandler());
