import { App, type Environment } from "aws-cdk-lib/core";
import { OtlpReceiverStack } from "./stacks/otlp-receiver.js";
import { OtlpSenderStack } from "./stacks/otlp-sender.js";
import { validateEnv } from "./utils/validate-env.js";

const env = validateEnv(["CDK_ACCOUNT_SRC", "CDK_ACCOUNT_TRG", "CDK_REGION_SHARED"]);

const srcEnv: Environment = {
  account: env.CDK_ACCOUNT_SRC,
  region: env.CDK_REGION_SHARED,
};
const trgEnv: Environment = {
  account: env.CDK_ACCOUNT_TRG,
  region: env.CDK_REGION_SHARED,
};

const app = new App();

const otlpSenderStack = new OtlpSenderStack(app, "cdk-cross-account-cwl-sub-org-src", {
  env: srcEnv,
});
const otlpReceiverStack = new OtlpReceiverStack(app, "cdk-cross-account-cwl-sub-org-trg", {
  env: trgEnv,
});

otlpSenderStack.addStackDependency(otlpReceiverStack);

app.synth();
