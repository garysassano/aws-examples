import { App, Aspects, RemovalPolicies } from "aws-cdk-lib/core";
import { DenyLogGroupCreation } from "./aspects/deny-log-group-creation.js";
import { MyStack } from "./stacks/my-stack.js";

// for development, use account/region from cdk cli
const devEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const app = new App();

new MyStack(app, "cdk-lambda-node-esm-dev", { env: devEnv });

// Delete log groups with their stacks, so nothing is left behind and a redeploy can recreate them.
RemovalPolicies.of(app).destroy({ applyToResourceTypes: ["AWS::Logs::LogGroup"] });
// Keep Lambda from recreating a deleted log group with logs it delivers late.
Aspects.of(app).add(new DenyLogGroupCreation());

app.synth();
