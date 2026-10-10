import {
  EventAction,
  FilterGroup,
  GitHubSourceCredentials,
  Project,
  Source,
} from "aws-cdk-lib/aws-codebuild";
import { CfnOutput, SecretValue, Stack, type StackProps } from "aws-cdk-lib/core";
import type { Construct } from "constructs";
import { validateEnv } from "../utils/validate-env.js";

// Created before deployment, so the token never appears in the template.
const githubTokenSecretName: string = "github-token";

const env = validateEnv(["GITHUB_REPO", "GITHUB_OWNER"]);

export class MyStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    //==============================================================================
    // CODEBUILD
    //==============================================================================

    new GitHubSourceCredentials(this, "GithubSourceCredentials", {
      accessToken: SecretValue.secretsManager(githubTokenSecretName),
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
