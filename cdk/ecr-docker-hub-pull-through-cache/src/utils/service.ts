const SERVICES = ["ecs-express", "ecs-fargate", "apprunner", "all"] as const;

export type Service = (typeof SERVICES)[number];

// The app deploys ECS Express Mode unless told otherwise, since it works in every account
// and AWS recommends it as App Runner's replacement. Pass `-c service=ecs-fargate` or
// `-c service=apprunner` for another service, or `-c service=all` for all three.
export function getService(input: unknown): Service {
  if (input === undefined) {
    return "ecs-express";
  }

  const service = SERVICES.find((name) => name === input);
  if (service === undefined) {
    throw new Error(`service must be one of ${SERVICES.join(", ")}, got "${input}"`);
  }
  return service;
}
