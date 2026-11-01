# aws-examples

For CDK examples under `cdk/`, use `cdk/AGENTS.md`. For CDKTN examples under `cdktn/`, use `cdktn/AGENTS.md`.

## Example READMEs

Example READMEs use this section order, leaving out any that don't apply: intro, Related Apps, Prerequisites, Configuration, Installation, Development, Deployment, Usage, Cleanup, Architecture Diagram, Application Details, Comparison.

## Keep personal details out of the repository

Never write anything that identifies the author's machine or accounts into files, commit messages, PR titles or bodies, or PR comments: local paths such as home directories and WSL mounts, AWS profile or account names, account IDs, ARNs and resource IDs from a personal account, deployed URLs such as CloudFront or Modal endpoints, and tokens or secret names that are not part of the example's own documented setup. Say "a test AWS account" when describing where something was deployed. A squash merge copies the PR body into the commit on `main`, so check the body before opening the PR.
