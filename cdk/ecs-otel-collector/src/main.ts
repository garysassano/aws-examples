import { App } from "aws-cdk-lib/core";
import { MyStack } from "./stacks/my-stack.js";

// for development, use account/region from cdk cli
const devEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const app = new App();

new MyStack(app, "cdk-ecs-otel-collector-dev", { env: devEnv });

app.synth();
