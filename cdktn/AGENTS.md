# CDKTN examples

Create a new example by copying the closest existing one. Examples rely on the workspace root for `pnpm-workspace.yaml`, `catalog:` versions, `.gitignore`, `LICENSE`, and Biome's base config.

- Declare every log group a function, task, or build project writes to, with a retention period, and point the resource at it. Give the role only `logs:CreateLogStream` and `logs:PutLogEvents` on that group, never `logs:CreateLogGroup` or `AWSLambdaBasicExecutionRole`, which grants it, so a service cannot recreate the group after `pnpm destroy`. Grant no logs access to a role that writes no logs.
- Helpers such as `src/utils/validate-env.ts` are copied into each example, never shared, so an example keeps working when copied out of the repository.
- A README's Prerequisites list every environment variable the app needs to synthesize, and its Cleanup mentions anything `pnpm destroy` leaves behind, such as a resource the app does not manage, and nothing otherwise.

## Done

`pnpm check` passes in the example; it is local and safe to rerun. The example has been deployed to a test AWS account, exercised, and destroyed with nothing left behind.
