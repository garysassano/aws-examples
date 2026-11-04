import { App, Aspects, RemovalPolicies } from "aws-cdk-lib/core";
import { DenyLogGroupCreation } from "./aspects/deny-log-group-creation.js";
import { COMPUTE_STACK, REGION } from "./constants.js";
import { ComputeStack } from "./stacks/compute-stack.js";
import { ImageStack } from "./stacks/image-stack.js";

const devEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: REGION,
};

const app = new App();

const image = new ImageStack(app, "cdk-soci-lazy-loading-image-dev", { env: devEnv });

new ComputeStack(app, COMPUTE_STACK, {
  env: devEnv,
  repository: image.repository,
});

// Delete log groups with their stacks, so nothing is left behind and a redeploy can recreate them.
RemovalPolicies.of(app).destroy({ applyToResourceTypes: ["AWS::Logs::LogGroup"] });
// Keep Lambda from recreating a deleted log group with logs it delivers late.
Aspects.of(app).add(new DenyLogGroupCreation());

app.synth();
