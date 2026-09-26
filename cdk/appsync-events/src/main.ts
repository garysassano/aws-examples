import { App } from "aws-cdk-lib/core";
import { MyStack } from "./stacks/my-stack.js";

const devEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const app = new App();

new MyStack(app, "cdk-appsync-events-dev", { env: devEnv });

app.synth();
