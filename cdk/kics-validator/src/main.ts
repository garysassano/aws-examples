import {
  KicsValidator,
  QueryCategory,
  Severity,
} from "@checkmarx/cdk-validator-kics/lib/plugin.js";
import { App, Validations } from "aws-cdk-lib/core";
import { MyStack } from "./stacks/my-stack.js";

// for development, use account/region from cdk cli
const devEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const app = new App();

Validations.of(app).addPlugins(
  new KicsValidator({
    excludeCategories: [QueryCategory.BEST_PRACTICES],
    excludeSeverities: [Severity.LOW, Severity.MEDIUM],
  }),
);

new MyStack(app, "cdk-kics-validator-dev", { env: devEnv });

app.synth();
