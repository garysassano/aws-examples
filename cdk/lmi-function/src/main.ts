import { App } from "aws-cdk-lib/core";
import { MyStack } from "./stacks/my-stack.js";

const devEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: "eu-west-1",
};

const app = new App();

new MyStack(app, "cdk-lmi-function-dev", {
  env: devEnv,
});

app.synth();
