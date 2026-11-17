import { readFileSync } from "node:fs";
import { App, Testing } from "cdktn";
import { describe, expect, it, vi } from "vitest";

// The CLI passes these to the app; validation rejects write-only attributes without them.
const { targetVersions } = JSON.parse(readFileSync("cdktf.json", "utf8"));

// The stack reads its environment at import time, so each synth imports a fresh copy.
const synth = async (githubOrg?: string) => {
  vi.resetModules();
  vi.stubEnv("GITHUB_TOKEN", "test-token");
  vi.stubEnv("GITHUB_ORG", githubOrg ?? "");
  const { MyStack } = await import("../src/stacks/my-stack.js");
  // `runValidations` makes synth fail on construct-level validation errors.
  const synthesized = Testing.synth(
    new MyStack(new App({ context: { targetVersions } }), "test"),
    true,
  );
  vi.unstubAllEnvs();
  return { synthesized, resources: JSON.parse(synthesized).resource };
};

describe("MyStack", async () => {
  const { synthesized, resources } = await synth();

  it("configures the AWS and GitHub providers", () => {
    expect(Testing.toHaveProvider(synthesized, "aws")).toBe(true);
    expect(Testing.toHaveProvider(synthesized, "github")).toBe(true);
  });

  it("keeps the token in a write-only secret in the format CodeBuild reads", () => {
    const version = resources.aws_secretsmanager_secret_version.GithubTokenSecretVersion;

    expect(version.secret_string).toBeUndefined();
    expect(JSON.parse(version.secret_string_wo)).toEqual({
      ServerType: "GITHUB",
      AuthType: "PERSONAL_ACCESS_TOKEN",
      Token: "test-token",
    });
  });

  it("uses the secret as this project's credential, not the account's", () => {
    expect(resources.aws_codebuild_source_credential).toBeUndefined();
    const { auth } = resources.aws_codebuild_project.Project.source;

    expect(auth.type).toBe("SECRETS_MANAGER");
    expect(auth.resource).toContain("aws_secretsmanager_secret.GithubTokenSecret.arn");
  });

  it("deletes the webhook before the token CodeBuild needs to remove it", () => {
    expect(resources.aws_codebuild_webhook.Webhook.depends_on).toContain(
      "aws_secretsmanager_secret_version.GithubTokenSecretVersion",
    );
  });

  it("triggers only on queued GitHub Actions jobs", () => {
    expect(resources.aws_codebuild_webhook.Webhook.filter_group[0].filter[0]).toMatchObject({
      type: "EVENT",
      pattern: "WORKFLOW_JOB_QUEUED",
    });
  });

  it("commits a workflow whose runs-on targets the CodeBuild project", () => {
    const file = resources.github_repository_file.GhaWorkflowFile;

    expect(file.file).toBe(".github/workflows/hello-world.yml");
    // `Fn.rawString` doubles the dollar so Terraform emits a literal `${{ ... }}`
    // for GitHub Actions instead of trying to interpolate it itself.
    expect(file.content).toContain("$${{ github.run_id }}-$${{ github.run_attempt }}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Terraform interpolation, not a JS template literal
    expect(file.content).toContain("codebuild-${aws_codebuild_project.Project.name}");
  });

  describe("without GITHUB_ORG", () => {
    it("creates the repository in the token owner's account", () => {
      expect(JSON.parse(synthesized).provider.github[0].owner).toBeUndefined();
    });

    it("builds from the sample repository with a repository webhook", () => {
      const project = resources.aws_codebuild_project.Project;

      expect(project.source.location).toContain("github_repository.SampleRepo.html_url");
      expect(resources.aws_codebuild_webhook.Webhook.scope_configuration).toBeUndefined();
    });
  });

  describe("with GITHUB_ORG", async () => {
    const org = await synth("test-org");

    it("creates the repository in the organization", () => {
      expect(JSON.parse(org.synthesized).provider.github[0].owner).toBe("test-org");
    });

    it("scopes the webhook to the whole organization", () => {
      const project = org.resources.aws_codebuild_project.Project;

      expect(project.source.location).toBe("CODEBUILD_DEFAULT_WEBHOOK_SOURCE_LOCATION");
      expect(org.resources.aws_codebuild_webhook.Webhook.scope_configuration).toEqual({
        scope: "GITHUB_ORGANIZATION",
        name: "test-org",
      });
    });
  });
});
