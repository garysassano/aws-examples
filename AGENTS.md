# aws-examples

For CDK examples under `cdk/`, use `cdk/AGENTS.md`. For CDKTN examples under `cdktn/`, use `cdktn/AGENTS.md`.

## Example READMEs

Give every example's README these sections in this order, leaving out any that don't apply:

1. Title and intro, which says what the app does and, when the example exists to compare things, the headline result
2. `### Related Apps`, after the whole intro
3. `## Prerequisites`
4. `## Configuration` - Manual setup before installing, such as bootstrapping several accounts
5. `## Installation`
6. `## Development` - Running locally and testing
7. `## Deployment` - Deploy commands and their options
8. `## Usage` - Exercising what was deployed
9. `## Cleanup`
10. `## Architecture Diagram` - The diagram and numbered flow, with `### High Level` and `### Low Level` when there are two diagrams, then `### Design Notes`
11. `## Application Details` - Functions, endpoints, environment variables, and how the app works
12. `## Comparison` - Alternatives, measurements, and cost, under this name whatever is being compared

## Keep personal details out of the repository

Never write anything that identifies the author's machine or accounts into files, commit messages, PR titles or bodies, or PR comments: local paths such as home directories and WSL mounts, AWS profile or account names, account IDs, ARNs and resource IDs from a personal account, deployed URLs such as CloudFront or Modal endpoints, and tokens or secret names that are not part of the example's own documented setup. Say "a test AWS account" when describing where something was deployed. A squash merge copies the PR body into the commit on `main`, so check the body before opening the PR.
