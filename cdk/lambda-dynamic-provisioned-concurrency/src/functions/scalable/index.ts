import { Logger } from "@aws-lambda-powertools/logger";
import { injectLambdaContext } from "@aws-lambda-powertools/logger/middleware";
import middy from "@middy/core";
import httpErrorHandler from "@middy/http-error-handler";

type LambdaResponse = {
  statusCode: number;
  body: string;
};

const logger = new Logger();

const lambdaHandler = async (): Promise<LambdaResponse> => {
  const response = {
    statusCode: 200,
    body: "Hello from Lambda!",
  };

  return response;
};

export const handler = middy(lambdaHandler)
  .use(injectLambdaContext(logger))
  .use(httpErrorHandler());
