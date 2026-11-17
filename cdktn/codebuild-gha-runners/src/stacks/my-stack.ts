import { Fn, TerraformOutput, TerraformStack } from "cdktn";
import type { Construct } from "constructs";
import YAML from "yaml";
import { CloudwatchLogGroup } from "../../.gen/providers/aws/cloudwatch-log-group/index.js";
import { CodebuildProject } from "../../.gen/providers/aws/codebuild-project/index.js";
import { CodebuildWebhook } from "../../.gen/providers/aws/codebuild-webhook/index.js";
import { DataAwsIamPolicyDocument } from "../../.gen/providers/aws/data-aws-iam-policy-document/index.js";
import { IamRole } from "../../.gen/providers/aws/iam-role/index.js";
import { AwsProvider } from "../../.gen/providers/aws/provider/index.js";
import { SecretsmanagerSecret } from "../../.gen/providers/aws/secretsmanager-secret/index.js";
import { SecretsmanagerSecretVersion } from "../../.gen/providers/aws/secretsmanager-secret-version/index.js";
import { GithubProvider } from "../../.gen/providers/github/provider/index.js";
import { Repository } from "../../.gen/providers/github/repository/index.js";
import { RepositoryFile } from "../../.gen/providers/github/repository-file/index.js";
import { validateEnv } from "../utils/validate-env.js";

const env = validateEnv(["GITHUB_TOKEN"]);

// Set to deploy the repository into this organization and give CodeBuild an organization
// webhook, so every repository in it can use the runners. Unset, the repository goes into
// the token owner's personal account with a repository webhook.
const githubOrg = process.env.GITHUB_ORG || undefined;

const projectName = "gha-runners";

export class MyStack extends TerraformStack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    //==============================================================================
    // PROVIDERS
    //==============================================================================

    new AwsProvider(this, "AwsProvider");
    new GithubProvider(this, "GithubProvider", { owner: githubOrg });

    //==============================================================================
    // GITHUB
    //==============================================================================

    const sampleRepo = new Repository(this, "SampleRepo", {
      name: "codebuild-gha-runners-sample",
      autoInit: true,
    });

    //==============================================================================
    // SECRETS MANAGER
    //==============================================================================

    // Credential for this project only. An account-level CodeBuild source credential would
    // replace the one every other project in the Region uses, and destroy would delete it.
    const githubTokenSecret = new SecretsmanagerSecret(this, "GithubTokenSecret", {
      name: `codebuild/${projectName}/github-token`,
      // Delete at once on destroy, so a redeploy can reuse the name.
      recoveryWindowInDays: 0,
      // Lets the CodeBuild console list the secret as a GitHub credential.
      tags: {
        "codebuild:source": "",
        "codebuild:source:provider": "github",
        "codebuild:source:type": "personal_access_token",
      },
    });

    const githubTokenSecretVersion = new SecretsmanagerSecretVersion(
      this,
      "GithubTokenSecretVersion",
      {
        secretId: githubTokenSecret.id,
        // Write-only, so the token stays out of the Terraform state.
        secretStringWo: JSON.stringify({
          ServerType: "GITHUB",
          AuthType: "PERSONAL_ACCESS_TOKEN",
          Token: env.GITHUB_TOKEN,
        }),
        // Bump to push a rotated token.
        secretStringWoVersion: 1,
      },
    );

    //==============================================================================
    // CLOUDWATCH LOGS
    //==============================================================================

    // Declared rather than left for CodeBuild to create, so destroy removes it and its
    // logs expire.
    const projectLogGroup = new CloudwatchLogGroup(this, "ProjectLogGroup", {
      name: `/aws/codebuild/${projectName}`,
      retentionInDays: 7,
    });

    //==============================================================================
    // IAM
    //==============================================================================

    const codebuildAssumeRolePolicy = new DataAwsIamPolicyDocument(
      this,
      "CodebuildAssumeRolePolicy",
      {
        statement: [
          {
            effect: "Allow",
            actions: ["sts:AssumeRole"],
            principals: [{ type: "Service", identifiers: ["codebuild.amazonaws.com"] }],
          },
        ],
      },
    );

    const projectPolicy = new DataAwsIamPolicyDocument(this, "ProjectPolicy", {
      statement: [
        // Without logs:CreateLogGroup, CodeBuild cannot recreate the group after a destroy.
        {
          effect: "Allow",
          actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
          resources: [`${projectLogGroup.arn}:*`],
        },
        {
          effect: "Allow",
          actions: ["secretsmanager:GetSecretValue"],
          resources: [githubTokenSecret.arn],
        },
      ],
    });

    const projectRole = new IamRole(this, "ProjectRole", {
      name: `codebuild-${projectName}`,
      assumeRolePolicy: codebuildAssumeRolePolicy.json,
      inlinePolicy: [{ name: "project-policy", policy: projectPolicy.json }],
    });

    //==============================================================================
    // CODEBUILD
    //==============================================================================

    const project = new CodebuildProject(this, "Project", {
      name: projectName,
      serviceRole: projectRole.arn,
      source: {
        type: "GITHUB",
        // An organization webhook takes events from every repository, so the project
        // has no single repository to point at.
        location: githubOrg ? "CODEBUILD_DEFAULT_WEBHOOK_SOURCE_LOCATION" : sampleRepo.htmlUrl,
        auth: { type: "SECRETS_MANAGER", resource: githubTokenSecret.arn },
      },
      // Default for jobs whose runs-on label overrides nothing: Ubuntu 24.04 on x86, like
      // GitHub's ubuntu-latest.
      environment: {
        type: "LINUX_CONTAINER",
        computeType: "BUILD_GENERAL1_SMALL",
        image: "aws/codebuild/standard:8.0",
      },
      artifacts: { type: "NO_ARTIFACTS" },
      logsConfig: {
        cloudwatchLogs: { groupName: projectLogGroup.name },
      },
    });

    new CodebuildWebhook(this, "Webhook", {
      // CodeBuild reads the token to create the webhook, and to delete it on destroy.
      dependsOn: [githubTokenSecretVersion],
      projectName: project.name,
      scopeConfiguration: githubOrg ? { scope: "GITHUB_ORGANIZATION", name: githubOrg } : undefined,
      filterGroup: [
        {
          filter: [{ type: "EVENT", pattern: "WORKFLOW_JOB_QUEUED" }],
        },
      ],
    });

    //==============================================================================
    // GHA WORKFLOWS
    //==============================================================================

    // CodeBuild matches jobs to the project by this label prefix; the run ID and attempt
    // let it cancel the build when the workflow run is canceled.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression, kept literal by Fn.rawString
    const runnerLabel = `codebuild-${project.name}-${Fn.rawString("${{ github.run_id }}-${{ github.run_attempt }}")}`;

    const ghaWorkflow = {
      name: "Hello World",
      on: { workflow_dispatch: {} },
      jobs: {
        // Runs on the project's default environment.
        ubuntu: {
          "runs-on": runnerLabel,
          steps: [{ run: 'echo "Hello from $(uname -m)"' }],
        },
        // Overrides the image and instance size for this job only.
        arm: {
          "runs-on": `${runnerLabel}-arm-3.0-small`,
          steps: [{ run: 'echo "Hello from $(uname -m)"' }],
        },
      },
    };

    new RepositoryFile(this, "GhaWorkflowFile", {
      repository: sampleRepo.name,
      file: ".github/workflows/hello-world.yml",
      content: YAML.stringify(ghaWorkflow),
      commitMessage: "Add GHA workflow file",
    });

    //==============================================================================
    // OUTPUTS
    //==============================================================================

    new TerraformOutput(this, "GhaWorkflowUrl", {
      value: `${sampleRepo.htmlUrl}/actions/workflows/hello-world.yml`,
      description: "URL to the GitHub Actions workflow",
    });
  }
}
