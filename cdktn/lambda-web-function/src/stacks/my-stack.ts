import { join } from "node:path";
import { TerraformOutput, TerraformStack } from "cdktn";
import type { Construct } from "constructs";
import { DynamodbTable } from "../../.gen/providers/aws/dynamodb-table/index.js";
import { IamRolePolicy } from "../../.gen/providers/aws/iam-role-policy/index.js";
import { AwsProvider } from "../../.gen/providers/aws/provider/index.js";
import { AwsccProvider } from "../../.gen/providers/awscc/provider/index.js";
import { LambdaWebApp } from "../constructs/lambda-web-app.js";

// Web Functions run in only some Regions; see the README.
const region = "eu-central-1";
const functionsDir = join(import.meta.dirname, "../functions");

export class MyStack extends TerraformStack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new AwsProvider(this, "AwsProvider", { region });

    // Web Functions are only in the Cloud Control provider so far.
    new AwsccProvider(this, "AwsccProvider", { region });

    // One item holds the count, which the backend increments atomically.
    const table = new DynamodbTable(this, "Clicks", {
      name: "lambda-web-function-clicks",
      billingMode: "PAY_PER_REQUEST",
      hashKey: "id",
      attribute: [{ name: "id", type: "S" }],
    });

    // Hono API that keeps the click count in DynamoDB. Only the frontend may call it:
    // its endpoint accepts SigV4-signed requests from IAM principals with permission.
    const backend = new LambdaWebApp(this, "Backend", {
      name: "hono-backend",
      codeDir: join(functionsDir, "backend"),
      entrypoint: "index.mjs",
      authType: "IamAuth",
      environment: {
        TABLE_NAME: table.name,
      },
    });
    new IamRolePolicy(this, "BackendCountsClicks", {
      name: "count-clicks",
      role: backend.role.name,
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
            Resource: table.arn,
          },
        ],
      }),
    });

    // SvelteKit app that renders the count and calls the API from the server, signing
    // each request with its execution role's credentials.
    const frontend = new LambdaWebApp(this, "Frontend", {
      name: "sveltekit-frontend",
      codeDir: join(functionsDir, "frontend"),
      authType: "ApplicationManaged",
      environment: {
        BACKEND_URL: backend.url,
      },
    });

    backend.grantInvoke(frontend);

    new TerraformOutput(this, "FrontendUrl", { value: frontend.url });
    new TerraformOutput(this, "BackendUrl", { value: backend.url });
  }
}
