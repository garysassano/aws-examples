# AWS CDK examples

Code follows the `aws-cdk-conventions` skill. Create a new example by copying the closest existing one rather than running that skill's scaffold, which writes a standalone repository; examples here rely on the workspace root for `pnpm-workspace.yaml`, `catalog:` versions, `.gitignore`, `LICENSE`, and Biome's base config.

- Helpers such as `src/utils/validate-env.ts` and `src/aspects/deny-log-group-creation.ts` are copied into each example, never shared, so an example keeps working when copied out of the repository.
- All examples share the same `cdk.json`. When the latest `cdk init` changes its recommended feature flags, update every example together.
- A README's Prerequisites list every environment variable or `-c` value the app needs to synthesize, and its Cleanup says what `pnpm destroy` leaves behind.

## Done

`pnpm check` passes in the example; it is local and safe to rerun. The example has been deployed to a test AWS account, exercised, and destroyed with nothing left behind.
