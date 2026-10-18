import { join } from "node:path";
import { TerraformOutput, TerraformStack } from "cdktn";
import type { Construct } from "constructs";
import { IamRolePolicy } from "../../.gen/providers/aws/iam-role-policy/index.js";
import { AwsProvider } from "../../.gen/providers/aws/provider/index.js";
import { SsmParameter } from "../../.gen/providers/aws/ssm-parameter/index.js";
import { AwsccProvider } from "../../.gen/providers/awscc/provider/index.js";
import { UpstashProvider } from "../../.gen/providers/upstash/provider/index.js";
import { RedisDatabase } from "../../.gen/providers/upstash/redis-database/index.js";
import { LambdaWebApp } from "../constructs/lambda-web-app.js";
import { validateEnv } from "../utils/validate-env.js";

const env = validateEnv(["UPSTASH_EMAIL", "UPSTASH_API_KEY"]);

// One of the Regions that offer Web Functions at launch.
const region = "eu-west-1";
const functionsDir = join(import.meta.dirname, "../functions");

export class MyStack extends TerraformStack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new AwsProvider(this, "AwsProvider", { region });

    // Web Functions are only in the Cloud Control provider so far.
    new AwsccProvider(this, "AwsccProvider", { region });

    new UpstashProvider(this, "UpstashProvider", {
      email: env.UPSTASH_EMAIL,
      apiKey: env.UPSTASH_API_KEY,
    });

    // Upstash Redis with its primary in the same region as the functions.
    const clickCounter = new RedisDatabase(this, "ClickCounter", {
      databaseName: "click-counter",
      region: "global",
      primaryRegion: region,
      tls: true,
    });

    // The REST token is a secret, so the backend reads it from a SecureString at
    // startup instead of finding it in its configuration. Terraform state still holds
    // it, as it holds every secret Terraform manages.
    const restToken = new SsmParameter(this, "UpstashRestToken", {
      name: "/lambda-web-function/upstash-redis-rest-token",
      type: "SecureString",
      value: clickCounter.restToken,
    });

    // Hono API that keeps the click count in Redis. Only the frontend may call it:
    // its endpoint accepts SigV4-signed requests from IAM principals with permission.
    const backend = new LambdaWebApp(this, "Backend", {
      name: "hono-backend",
      codeDir: join(functionsDir, "backend"),
      entrypoint: "index.mjs",
      authType: "IamAuth",
      environment: {
        UPSTASH_REDIS_REST_URL: `https://${clickCounter.endpoint}`,
        UPSTASH_REDIS_REST_TOKEN_PARAMETER: restToken.name,
      },
    });
    // The AWS managed key aws/ssm lets any principal in the account decrypt, so this
    // grant is what limits who can read the token.
    new IamRolePolicy(this, "BackendReadsRestToken", {
      name: "read-upstash-rest-token",
      role: backend.role.name,
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: "ssm:GetParameter", Resource: restToken.arn }],
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
