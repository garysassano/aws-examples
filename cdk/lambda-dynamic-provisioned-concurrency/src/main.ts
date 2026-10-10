import { App } from "aws-cdk-lib/core";
import { LambdaDPCAdvanced } from "./stacks/lambda-dpc-advanced.js";
import { LambdaDPCBasic } from "./stacks/lambda-dpc-basic.js";

// for development, use account/region from cdk cli
const devEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const app = new App();

new LambdaDPCBasic(app, "cdk-lambda-dpc-basic-dev", {
  env: devEnv,
});

new LambdaDPCAdvanced(app, "cdk-lambda-dpc-advanced-dev", {
  env: devEnv,
});

app.synth();
