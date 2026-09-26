# aws-examples

Small, self-contained AWS examples, grouped by the tool that deploys them: `cdk/`, `cdktn/`, and `sst/`. Each example has its own README, and apps built with more than one tool link to their counterparts.

The repository is a single pnpm workspace; `pnpm check` from the root lints, typechecks, tests, and builds every example. Examples that read credentials or account IDs from the environment refuse to synthesize without them; each one's README lists what it needs.
