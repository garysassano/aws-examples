import {
  EventAction,
  FilterGroup,
  GitHubSourceCredentials,
  Project,
  Source,
} from "aws-cdk-lib/aws-codebuild";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { CfnOutput, SecretValue, Stack, type StackProps } from "aws-cdk-lib/core";
import type { Construct } from "constructs";
import { validateEnv } from "../utils/validate-env.js";

const env = validateEnv(["GITHUB_TOKEN", "GITHUB_REPO", "GITHUB_OWNER"]);

export class MyStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    //==============================================================================
    // SECRETS MANAGER
    //==============================================================================

    const githubTokenSecret = new Secret(this, "GithubTokenSecret", {
      secretName: "github-token",
      secretStringValue: SecretValue.unsafePlainText(env.GITHUB_TOKEN),
    });

    //==============================================================================
    // CODEBUILD
    //==============================================================================

    new GitHubSourceCredentials(this, "GithubSourceCredentials", {
      accessToken: SecretValue.secretsManager(githubTokenSecret.secretArn),
    });

    const sampleProject = new Project(this, "SampleProject", {
      projectName: "sample-project",
      source: Source.gitHub({
        owner: env.GITHUB_OWNER,
        repo: env.GITHUB_REPO,
        webhook: true,
        webhookFilters: [FilterGroup.inEventOf(EventAction.WORKFLOW_JOB_QUEUED)],
      }),
    });

    //==============================================================================
    // OUTPUTS
    //==============================================================================

    new CfnOutput(this, "GhaRunnerLabel", {
      value: `codebuild-${sampleProject.projectName}-$\{github.run_id}-$\{github.run_attempt}`,
      description: "GitHub Actions runner label for the CodeBuild project",
    });
  }
}
