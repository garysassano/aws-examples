# AWS CDK examples

Each directory here is a self-contained AWS CDK app and a package of the root pnpm workspace. Code follows the `aws-cdk-conventions` skill, except for how a new example is created.

## Adding an example

Copy the existing example closest to the new one and rename it, rather than running the `aws-cdk-conventions` scaffold. The scaffold writes a standalone repository, while an example here relies on the workspace root:

- Shared dependency versions come from the root `catalog:`. A dependency only one example uses is pinned in that example's `package.json`.
- The root owns `pnpm-workspace.yaml`, `.gitignore`, `LICENSE`, and Biome's base config. Add a `mise.toml` only when the example needs a tool the root does not provide.
- Helpers such as `src/utils/validate-env.ts` and `src/aspects/deny-log-group-creation.ts` are copied into each example, never shared, so an example still works when copied out of the repository.

## Every example

- `cdk.json` is exactly what the latest `cdk init` writes, with `"app": "node --import tsx src/main.ts"` and `"cli-telemetry": false` at the end of `context`. When the CLI's recommended flags change, update every example's `cdk.json` together.
- `src/main.ts` ends with the two log-group aspects, `RemovalPolicies.of(app).destroy(...)` for `AWS::Logs::LogGroup` and `DenyLogGroupCreation`. Do not add per-function log groups or `removalPolicy` on log groups.
- The README has Prerequisites, Installation, Deployment, and Cleanup sections, plus Usage when there is something to try. Prerequisites list every environment variable or `-c` context value the app needs to synthesize, and Cleanup says what `pnpm destroy` leaves behind.

## Done

`pnpm check` passes in the example, and it has been deployed to a test AWS account, exercised, and destroyed with nothing left behind.
