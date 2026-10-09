import { App, Testing } from "cdktn";
import { beforeAll, describe, expect, it } from "vitest";

// biome-ignore lint/suspicious/noExplicitAny: synthesized Terraform JSON
type Resources = Record<string, Record<string, any>>;

const apps = [
  { id: "Backend", dir: "backend", name: "hono-backend" },
  { id: "Frontend", dir: "frontend", name: "sveltekit-frontend" },
] as const;

describe("MyStack", () => {
  let synthesized: string;
  let resource: Resources;

  /** The single resource of `type` inside the LambdaWebApp construct `id`. */
  const inApp = (type: string, id: string) => {
    const matches = Object.entries(resource[type] ?? {}).filter(([key]) =>
      key.startsWith(`${id}_`),
    );
    expect(matches).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: length checked above
    const [key, value] = matches[0]!;
    return { key, ...value };
  };

  beforeAll(async () => {
    // The stack validates these at import time and throws without them.
    process.env.UPSTASH_EMAIL = "test@example.com";
    process.env.UPSTASH_API_KEY = "test-key";
    const { MyStack } = await import("../src/stacks/my-stack.js");
    // `runValidations` makes synth fail on construct-level validation errors.
    synthesized = Testing.synth(new MyStack(new App(), "test"), true);
    resource = JSON.parse(synthesized).resource;
  });

  it("configures the AWS, Docker and Upstash providers", () => {
    expect(Testing.toHaveProvider(synthesized, "aws")).toBe(true);
    expect(Testing.toHaveProvider(synthesized, "docker")).toBe(true);
    expect(Testing.toHaveProvider(synthesized, "upstash")).toBe(true);
  });

  it("creates a TLS Redis database in the same region as the Lambdas", () => {
    expect(
      Testing.toHaveResourceWithProperties(synthesized, "upstash_redis_database", {
        database_name: "click-counter",
        region: "global",
        primary_region: "eu-central-1",
        tls: true,
      }),
    ).toBe(true);
  });

  it.each(apps)("lets destroy remove the $name image repository", ({ id, name }) => {
    const repo = inApp("aws_ecr_repository", id);

    expect(repo.name).toBe(name);
    // ECR refuses to delete a non-empty repository, and this stack always pushes an image.
    expect(repo.force_delete).toBe(true);
  });

  it.each(apps)("builds the $name image for arm64 and rebuilds it on change", ({ id, dir }) => {
    const image = inApp("docker_image", id);
    const push = inApp("docker_registry_image", id);

    expect(image.build.platform).toBe("linux/arm64");
    // Attestations would make this an OCI manifest list, which Lambda rejects.
    expect(image.build.provenance).toBe("false");
    expect(image.build.sbom).toBe("false");
    expect(image.build.context).toMatch(new RegExp(`src/functions/${dir}$`));
    // A hash of the whole build context, computed at synth time.
    expect(image.triggers.filesha256).toMatch(/^[0-9a-f]{64}$/);
    expect(push.triggers.filesha256).toBe(image.triggers.filesha256);
  });

  it.each(apps)("deploys $name from its pushed image digest", ({ id, name }) => {
    const fn = inApp("aws_lambda_function", id);
    const push = inApp("docker_registry_image", id);

    expect(fn.function_name).toBe(name);
    expect(fn.package_type).toBe("Image");
    expect(fn.architectures).toEqual(["arm64"]);
    expect(fn.memory_size).toBe(1769);
    expect(fn.image_uri).toBe(
      `\${docker_registry_image.${push.key}.name}@\${docker_registry_image.${push.key}.sha256_digest}`,
    );
  });

  it("passes the Redis REST URL and the token's parameter name, never the token", () => {
    const back = inApp("aws_lambda_function", "Backend").environment.variables;
    const front = inApp("aws_lambda_function", "Frontend").environment.variables;
    const backUrl = inApp("aws_lambda_function_url", "Backend");

    expect(back.UPSTASH_REDIS_REST_URL).toBe(
      `https://\${upstash_redis_database.ClickCounter.endpoint}`,
    );
    expect(back.UPSTASH_REDIS_REST_TOKEN_PARAMETER).toBe(
      `\${aws_ssm_parameter.UpstashRestToken.name}`,
    );
    expect(JSON.stringify(back)).not.toContain("rest_token");
    expect(front.BACKEND_URL).toBe(`\${aws_lambda_function_url.${backUrl.key}.function_url}`);
  });

  it("keeps the REST token in a SecureString only the backend can read", () => {
    const param = resource.aws_ssm_parameter?.UpstashRestToken;
    expect(param.type).toBe("SecureString");
    expect(param.value).toBe(`\${upstash_redis_database.ClickCounter.rest_token}`);

    const grant = resource.aws_iam_role_policy?.BackendReadsRestToken;
    expect(grant.role).toBe(`\${aws_iam_role.${inApp("aws_iam_role", "Backend").key}.name}`);
    expect(JSON.parse(grant.policy).Statement).toEqual([
      {
        Effect: "Allow",
        Action: "ssm:GetParameter",
        Resource: `\${aws_ssm_parameter.UpstashRestToken.arn}`,
      },
    ]);
  });

  it("gives each function its own execution role", () => {
    const roles = apps.map(({ id }) => inApp("aws_iam_role", id));
    expect(roles.map((role) => role.name)).toEqual([
      "hono-backend-execution-role",
      "sveltekit-frontend-execution-role",
    ]);
    for (const { id } of apps) {
      const role = inApp("aws_iam_role", id);
      expect(inApp("aws_lambda_function", id).role).toBe(`\${aws_iam_role.${role.key}.arn}`);
    }
  });

  it("serves the frontend to anyone and the backend only to signed IAM requests", () => {
    expect(inApp("aws_lambda_function_url", "Frontend").authorization_type).toBe("NONE");
    expect(inApp("aws_lambda_function_url", "Backend").authorization_type).toBe("AWS_IAM");
    expect(Object.keys(JSON.parse(synthesized).output)).toEqual(
      expect.arrayContaining(["FrontendUrl", "BackendUrl"]),
    );
  });

  it("lets only the frontend's role invoke the backend, and only through its URL", () => {
    const grant = inApp("aws_iam_role_policy", "Backend");
    const backendFn = inApp("aws_lambda_function", "Backend");
    const frontendRole = inApp("aws_iam_role", "Frontend");
    const backendArn = `\${aws_lambda_function.${backendFn.key}.arn}`;

    expect(grant.role).toBe(`\${aws_iam_role.${frontendRole.key}.name}`);
    expect(JSON.parse(grant.policy).Statement).toEqual([
      {
        Effect: "Allow",
        Action: "lambda:InvokeFunctionUrl",
        Resource: backendArn,
        Condition: { StringEquals: { "lambda:FunctionUrlAuthType": "AWS_IAM" } },
      },
      {
        Effect: "Allow",
        Action: "lambda:InvokeFunction",
        Resource: backendArn,
        Condition: { Bool: { "lambda:InvokedViaFunctionUrl": "true" } },
      },
    ]);
  });
});
