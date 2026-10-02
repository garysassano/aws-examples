import { App, type Environment } from "aws-cdk-lib/core";
import { OtlpReceiverStack } from "./stacks/otlp-receiver.js";
import { OtlpSenderStack } from "./stacks/otlp-sender.js";
import { getTransport } from "./utils/transport.js";
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

const transport = getTransport(app.node.tryGetContext("transport"));

const otlpReceiverStack = new OtlpReceiverStack(
  app,
  "cdk-serverless-otlp-forwarder-cross-account-trg",
  { env: trgEnv, transport },
);
const otlpSenderStack = new OtlpSenderStack(
  app,
  "cdk-serverless-otlp-forwarder-cross-account-src",
  {
    env: srcEnv,
    transport,
    targetAccount: env.CDK_ACCOUNT_TRG,
  },
);

// The sender subscribes to, or publishes into, resources the receiver creates.
otlpSenderStack.addStackDependency(otlpReceiverStack);

app.synth();
