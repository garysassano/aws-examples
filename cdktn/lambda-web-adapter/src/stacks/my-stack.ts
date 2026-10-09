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
    const token = new DataAwsEcrAuthorizationToken(this, "EcrToken");
    new DockerProvider(this, "DockerProvider", {
      registryAuth: [
        {
          address: token.proxyEndpoint,
          username: token.userName,
          password: token.password,
        },
      ],
    });

    // Upstash Redis with its primary in the same region as the functions.
    const redisDatabase = new RedisDatabase(this, "RedisDatabase", {
      databaseName: "redis-database",
      region: "global",
      primaryRegion: region,
      tls: true,
    });

    const lambdaRole = new IamRole(this, "LambdaRole", {
      name: "lambda-role",
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
    new IamRolePolicyAttachment(this, "LambdaRolePolicyAttachment", {
      role: lambdaRole.name,
      policyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
    });

    // Hono API that keeps the click count in Redis.
    const back = new LambdaWebApp(this, "Back", {
      name: "back",
      buildContext: join(functionsDir, "back"),
      roleArn: lambdaRole.arn,
      environment: {
        UPSTASH_REDIS_REST_URL: `https://${redisDatabase.endpoint}`,
        UPSTASH_REDIS_REST_TOKEN: redisDatabase.restToken,
      },
    });

    // SvelteKit app that renders the count and calls the API from the server.
    const front = new LambdaWebApp(this, "Front", {
      name: "front",
      buildContext: join(functionsDir, "front"),
      roleArn: lambdaRole.arn,
      environment: {
        BACKEND_URL: back.functionUrl.functionUrl,
      },
    });

    new TerraformOutput(this, "FrontLambdaURL", { value: front.functionUrl.functionUrl });
    new TerraformOutput(this, "BackLambdaURL", { value: back.functionUrl.functionUrl });
  }
}
