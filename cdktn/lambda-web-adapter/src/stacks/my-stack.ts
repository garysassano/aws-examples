import { join } from "node:path";
import { TerraformOutput, TerraformStack } from "cdktn";
import type { Construct } from "constructs";
import { DataAwsEcrAuthorizationToken } from "../../.gen/providers/aws/data-aws-ecr-authorization-token/index.js";
import { IamRole } from "../../.gen/providers/aws/iam-role/index.js";
import { IamRolePolicyAttachment } from "../../.gen/providers/aws/iam-role-policy-attachment/index.js";
import { AwsProvider } from "../../.gen/providers/aws/provider/index.js";
import { DockerProvider } from "../../.gen/providers/docker/provider/index.js";
import { UpstashProvider } from "../../.gen/providers/upstash/provider/index.js";
import { RedisDatabase } from "../../.gen/providers/upstash/redis-database/index.js";
import { LambdaWebApp } from "../constructs/lambda-web-app.js";
import { validateEnv } from "../utils/validate-env.js";

const env = validateEnv(["UPSTASH_EMAIL", "UPSTASH_API_KEY"]);

const region = "eu-central-1";
const functionsDir = join(import.meta.dirname, "../functions");

export class MyStack extends TerraformStack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new AwsProvider(this, "AwsProvider", { region });

    new UpstashProvider(this, "UpstashProvider", {
      email: env.UPSTASH_EMAIL,
      apiKey: env.UPSTASH_API_KEY,
    });

    // Lets the Docker provider push to this account's ECR registry.
    const ecrToken = new DataAwsEcrAuthorizationToken(this, "EcrToken");
    new DockerProvider(this, "DockerProvider", {
      registryAuth: [
        {
          address: ecrToken.proxyEndpoint,
          username: ecrToken.userName,
          password: ecrToken.password,
        },
      ],
    });

    // Upstash Redis with its primary in the same region as the functions.
    const clickCounter = new RedisDatabase(this, "ClickCounter", {
      databaseName: "click-counter",
      region: "global",
      primaryRegion: region,
      tls: true,
    });

    const executionRole = new IamRole(this, "ExecutionRole", {
      name: "lambda-web-adapter-execution-role",
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "lambda.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      }),
    });
    new IamRolePolicyAttachment(this, "ExecutionRoleBasicPolicy", {
      role: executionRole.name,
      policyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
    });

    // Hono API that keeps the click count in Redis.
    const backend = new LambdaWebApp(this, "Backend", {
      name: "hono-backend",
      buildContext: join(functionsDir, "backend"),
      roleArn: executionRole.arn,
      environment: {
        UPSTASH_REDIS_REST_URL: `https://${clickCounter.endpoint}`,
        UPSTASH_REDIS_REST_TOKEN: clickCounter.restToken,
      },
    });

    // SvelteKit app that renders the count and calls the API from the server.
    const frontend = new LambdaWebApp(this, "Frontend", {
      name: "sveltekit-frontend",
      buildContext: join(functionsDir, "frontend"),
      roleArn: executionRole.arn,
      environment: {
        BACKEND_URL: backend.functionUrl.functionUrl,
      },
    });

    new TerraformOutput(this, "FrontendUrl", { value: frontend.functionUrl.functionUrl });
    new TerraformOutput(this, "BackendUrl", { value: backend.functionUrl.functionUrl });
  }
}
