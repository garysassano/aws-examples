import { App } from "aws-cdk-lib/core";
import { MyStack } from "./stacks/my-stack.js";

const devEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  // Pinned: c9g (Graviton5) instances are offered in only a few Regions
  region: "eu-central-1",
};

const app = new App();

new MyStack(app, "cdk-lambda-managed-instances-dev", {
  env: devEnv,
});

app.synth();
