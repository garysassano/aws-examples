import { App, Aspects, RemovalPolicies } from "aws-cdk-lib/core";
import { DenyLogGroupCreation } from "./aspects/deny-log-group-creation.js";
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

// Delete log groups with their stacks, so nothing is left behind and a redeploy can recreate them.
RemovalPolicies.of(app).destroy({ applyToResourceTypes: ["AWS::Logs::LogGroup"] });
// Keep Lambda from recreating a deleted log group with logs it delivers late.
Aspects.of(app).add(new DenyLogGroupCreation());

app.synth();
