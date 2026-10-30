import { randomUUID } from "node:crypto";
import { Logger } from "@aws-lambda-powertools/logger";
import { injectLambdaContext } from "@aws-lambda-powertools/logger/middleware";
import { JSONStringified } from "@aws-lambda-powertools/parser/helpers";
import { parser } from "@aws-lambda-powertools/parser/middleware";
import { APIGatewayProxyEventV2Schema } from "@aws-lambda-powertools/parser/schemas";
import { S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import middy from "@middy/core";
import { z } from "zod";
import { validateEnv } from "../../utils/validate-env.js";

//==============================================================================
// LAMBDA INITIALIZATION (COLD START)
//==============================================================================

const env = validateEnv(["UPLOADS_BUCKET_NAME"]);

// Initialize Powertools and AWS SDK clients
const logger = new Logger({ serviceName: "presignLambda" });
const s3Client = new S3Client();

// Rekognition reads JPEG and PNG images of up to 15 MB from S3.
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

// Define the schema for the upload request and create a type from it
const uploadRequestSchema = APIGatewayProxyEventV2Schema.extend({
  body: JSONStringified(
    // Strict, so a request with unexpected fields is rejected instead of silently ignored.
    z.strictObject({
      contentType: z.enum(["image/jpeg", "image/png"]),
    }),
  ),
});
type UploadRequest = z.infer<typeof uploadRequestSchema>;

//==============================================================================
// LAMBDA HANDLER
//==============================================================================

const lambdaHandler = async (event: UploadRequest) => {
  const { contentType } = event.body;
  const uploadId = randomUUID();

  // The signed policy lets the browser upload exactly one object of this type and size range;
  // S3 rejects anything else, which a presigned PUT URL cannot do.
  const { url, fields } = await createPresignedPost(s3Client, {
    Bucket: env.UPLOADS_BUCKET_NAME,
    Key: `uploads/${uploadId}`,
    Conditions: [["content-length-range", 1, MAX_UPLOAD_BYTES]],
    Fields: { "Content-Type": contentType },
    Expires: 300,
  });

  return {
    statusCode: 200,
    body: JSON.stringify({ uploadId, url, fields }),
  };
};

export const handler = middy(lambdaHandler)
  .use(injectLambdaContext(logger, { logEvent: true }))
  .use(
    parser({
      schema: uploadRequestSchema,
      // A body that fails validation is the caller's mistake, not a function error.
      errorHandler: () => ({
        statusCode: 400,
        body: JSON.stringify({
          message: "Send a JSON body with contentType image/jpeg or image/png",
        }),
      }),
    }),
  );
