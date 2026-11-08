import { App, Aspects, RemovalPolicies } from "aws-cdk-lib/core";
import { DenyLogGroupCreation } from "./aspects/deny-log-group-creation.js";
import { REGION, STACK_NAME } from "./constants.js";
import { MyStack } from "./stacks/my-stack.js";
import { validateEnv } from "./utils/validate-env.js";

const env = validateEnv(["DOMAIN_NAME", "HOSTED_ZONE_NAME"]);

const devEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: REGION,
};

const app = new App();

new MyStack(app, STACK_NAME, {
  env: devEnv,
  domainName: env.DOMAIN_NAME,
  hostedZoneName: env.HOSTED_ZONE_NAME,
});

// Delete log groups with their stacks, so nothing is left behind and a redeploy can recreate them.
RemovalPolicies.of(app).destroy({ applyToResourceTypes: ["AWS::Logs::LogGroup"] });
// Keep Lambda from recreating a deleted log group with logs it delivers late.
Aspects.of(app).add(new DenyLogGroupCreation());

app.synth();
