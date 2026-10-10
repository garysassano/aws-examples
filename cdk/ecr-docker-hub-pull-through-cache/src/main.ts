import { App } from "aws-cdk-lib/core";
import { AppRunnerStack } from "./stacks/apprunner-stack.js";
import { DockerHubCacheStack } from "./stacks/docker-hub-cache-stack.js";
import { EcsExpressStack } from "./stacks/ecs-express-stack.js";
import { EcsFargateStack } from "./stacks/ecs-fargate-stack.js";
import { getService } from "./utils/service.js";

// for development, use account/region from cdk cli
const devEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const app = new App();
const service = getService(app.node.tryGetContext("service"));

// The pull-through cache rule exists once per registry, so every service shares the same
// cache stack. Deploying a service stack deploys the cache stack too.
const cache = new DockerHubCacheStack(app, "cdk-ecr-docker-hub-pull-through-cache-dev", {
  env: devEnv,
});

if (service === "ecs-express" || service === "all") {
  new EcsExpressStack(app, "cdk-ecr-docker-hub-pull-through-cache-ecs-express-dev", {
    env: devEnv,
    cache,
  });
}
if (service === "ecs-fargate" || service === "all") {
  new EcsFargateStack(app, "cdk-ecr-docker-hub-pull-through-cache-ecs-fargate-dev", {
    env: devEnv,
    cache,
  });
}
if (service === "apprunner" || service === "all") {
  new AppRunnerStack(app, "cdk-ecr-docker-hub-pull-through-cache-apprunner-dev", {
    env: devEnv,
    cache,
  });
}

app.synth();
