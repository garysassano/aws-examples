import {
  KicsValidator,
  QueryCategory,
  Severity,
} from "@checkmarx/cdk-validator-kics/lib/plugin.js";
import { App, Aspects, RemovalPolicies, Validations } from "aws-cdk-lib/core";
import { DenyLogGroupCreation } from "./aspects/deny-log-group-creation.js";
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

// Delete log groups with their stacks, so nothing is left behind and a redeploy can recreate them.
RemovalPolicies.of(app).destroy({ applyToResourceTypes: ["AWS::Logs::LogGroup"] });
// Keep Lambda from recreating a deleted log group with logs it delivers late.
Aspects.of(app).add(new DenyLogGroupCreation());

app.synth();
