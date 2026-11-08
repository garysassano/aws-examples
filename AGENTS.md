# aws-examples

For CDK examples under `cdk/`, use `cdk/AGENTS.md`. For CDKTN examples under `cdktn/`, use `cdktn/AGENTS.md`.

## Example READMEs

Example READMEs use this section order, leaving out any that don't apply: intro, Related Apps, Prerequisites, Configuration, Installation, Development, Deployment, Usage, Cleanup, Architecture Diagram, Application Details, Comparison.
The title is `#`, Related Apps is `###` because it belongs to the intro, every other section is `##`, and subsections under them start at `###`.

A README describes the app as it is now. Don't link upstream issues or PRs that would change it, or say what can go once they ship; track that in an issue on this repository, and update the example when the change is released.

Measured results such as timings, sizes, and costs go stale as services change, so open each set of them with one sentence giving the date as `YYYY-MM-DD`, the Region, what the numbers depend on, and how they were sampled, for example "Measured on 2026-10-08 in `eu-central-1` with `nodejs24.x` on arm64, 1024 MB, and 15 interleaved cold starts per function." Date prices the same way ("list prices as of 2026-10-31"), and update the date whenever the numbers are re-measured.

## Keep personal details out of the repository

Never write anything that identifies the author's machine or accounts into files, commit messages, PR titles or bodies, or PR comments: local paths such as home directories and WSL mounts, AWS profile or account names, account IDs, ARNs and resource IDs from a personal account, deployed URLs such as CloudFront or Modal endpoints, and tokens or secret names that are not part of the example's own documented setup. Say "a test AWS account" when describing where something was deployed. A squash merge copies the PR body into the commit on `main`, so check the body before opening the PR.
