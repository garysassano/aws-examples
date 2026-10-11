import { App, Aspects, type Environment, RemovalPolicies } from "aws-cdk-lib/core";
import { DenyLogGroupCreation } from "./aspects/deny-log-group-creation.js";
import { LambdaStack } from "./stacks/lambda-stack.js";
import { StepfunctionsStack } from "./stacks/stepfunctions-stack.js";
import { validateEnv } from "./utils/validate-env.js";

const env = validateEnv(["CDK_ACCOUNT_SRC", "CDK_REGION_SRC", "CDK_ACCOUNT_TRG", "CDK_REGION_TRG"]);

const srcEnv: Environment = {
  account: env.CDK_ACCOUNT_SRC,
  region: env.CDK_REGION_SRC,
};
const trgEnv: Environment = {
  account: env.CDK_ACCOUNT_TRG,
  region: env.CDK_REGION_TRG,
};

const app = new App();

new StepfunctionsStack(app, "cdk-sfn-cross-account-lambda-src", {
  env: srcEnv,
});
new LambdaStack(app, "cdk-sfn-cross-account-lambda-trg", {
  env: trgEnv,
});

// Delete log groups with their stacks, so nothing is left behind and a redeploy can recreate them.
RemovalPolicies.of(app).destroy({ applyToResourceTypes: ["AWS::Logs::LogGroup"] });
// Keep Lambda from recreating a deleted log group with logs it delivers late.
Aspects.of(app).add(new DenyLogGroupCreation());

app.synth();
