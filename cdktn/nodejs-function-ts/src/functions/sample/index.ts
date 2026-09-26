import { Logger } from "@aws-lambda-powertools/logger";
import { injectLambdaContext } from "@aws-lambda-powertools/logger/middleware";
import middy from "@middy/core";
import httpErrorHandler from "@middy/http-error-handler";

const logger = new Logger();

const lambdaHandler = async (): Promise<any> => {
  const response = {
    statusCode: 200,
    body: JSON.stringify("Hello from Lambda!"),
  };

  return response;
};

export const handler = middy(lambdaHandler)
  .use(injectLambdaContext(logger, { logEvent: true }))
  .use(httpErrorHandler());
