import { App, Testing } from "cdktn";
import { beforeAll, describe, expect, it } from "vitest";

describe("MyStack", () => {
  let synthesized: string;

  beforeAll(async () => {
    // The stack validates this at import time and throws without it.
    process.env.GITHUB_TOKEN = "test-token";
    process.env.GITHUB_OWNER = "test-owner";
    const { MyStack } = await import("../src/stacks/my-stack.js");
    // `runValidations` makes synth fail on construct-level validation errors.
    synthesized = Testing.synth(new MyStack(new App(), "test"), true);
  });

  it("configures the AWS and GitHub providers", () => {
    expect(Testing.toHaveProvider(synthesized, "aws")).toBe(true);
    expect(Testing.toHaveProvider(synthesized, "github")).toBe(true);
  });

  it("registers the personal access token with CodeBuild", () => {
    expect(
      Testing.toHaveResourceWithProperties(synthesized, "aws_codebuild_source_credential", {
        auth_type: "PERSONAL_ACCESS_TOKEN",
        server_type: "GITHUB",
        token: "test-token",
      }),
    ).toBe(true);
  });

  it("builds from the sample repository with no artifacts", () => {
    expect(
      Testing.toHaveResourceWithProperties(synthesized, "aws_codebuild_project", {
        name: "sample-project",
        source: { type: "GITHUB", location: "CODEBUILD_DEFAULT_WEBHOOK_SOURCE_LOCATION" },
        environment: {
          type: "LINUX_CONTAINER",
          compute_type: "BUILD_GENERAL1_SMALL",
          image: "aws/codebuild/standard:7.0",
        },
        artifacts: { type: "NO_ARTIFACTS" },
      }),
    ).toBe(true);
  });

  it("scopes the webhook to the whole GitHub organization", () => {
    expect(
      Testing.toHaveResourceWithProperties(synthesized, "aws_codebuild_webhook", {
        scope_configuration: { scope: "GITHUB_ORGANIZATION", name: "test-owner" },
      }),
    ).toBe(true);
  });

  it("deletes the webhook before the credential CodeBuild needs to remove it", () => {
    const webhook = JSON.parse(synthesized).resource.aws_codebuild_webhook.CodebuildWebhook;

    expect(webhook.depends_on).toContain("aws_codebuild_source_credential.GithubSourceCredential");
  });

  it("triggers only on queued GitHub Actions jobs", () => {
    const webhook = JSON.parse(synthesized).resource.aws_codebuild_webhook.CodebuildWebhook;

    expect(webhook.filter_group[0].filter[0]).toMatchObject({
      type: "EVENT",
      pattern: "WORKFLOW_JOB_QUEUED",
    });
  });

  it("commits a workflow whose runs-on targets the CodeBuild project", () => {
    const file = JSON.parse(synthesized).resource.github_repository_file.GhaWorkflowFile;

    expect(file.file).toMatch(/^\.github\/workflows\//);
    // `Fn.rawString` doubles the dollar so Terraform emits a literal `${{ ... }}`
    // for GitHub Actions instead of trying to interpolate it itself.
    expect(file.content).toContain("$${{ github.run_id }}-$${{ github.run_attempt }}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Terraform interpolation, not a JS template literal
    const projectRef = "codebuild-${aws_codebuild_project.SampleProject.name}";
    expect(file.content).toContain(projectRef);
  });

  it("logs builds to a declared log group that the project role cannot recreate", () => {
    const parsed = JSON.parse(synthesized);
    const group = parsed.resource.aws_cloudwatch_log_group.SampleProjectLogGroup;
    const project = parsed.resource.aws_codebuild_project.SampleProject;
    const logsPolicy = parsed.data.aws_iam_policy_document.CWLogsPolicy;

    expect(group).toMatchObject({ name: "/aws/codebuild/sample-project", retention_in_days: 7 });
    expect(project.logs_config.cloudwatch_logs.group_name).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Terraform interpolation, not a JS template literal
      "${aws_cloudwatch_log_group.SampleProjectLogGroup.name}",
    );
    expect(logsPolicy.statement).toEqual([
      {
        effect: "Allow",
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Terraform interpolation, not a JS template literal
        resources: ["${aws_cloudwatch_log_group.SampleProjectLogGroup.arn}:*"],
      },
    ]);
  });
});
