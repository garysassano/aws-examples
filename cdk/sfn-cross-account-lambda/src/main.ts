import { App, type Environment } from "aws-cdk-lib/core";
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

app.synth();
