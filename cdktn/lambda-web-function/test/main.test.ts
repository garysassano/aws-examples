import { App, Testing } from "cdktn";
import { beforeAll, describe, expect, it } from "vitest";

// biome-ignore lint/suspicious/noExplicitAny: synthesized Terraform JSON
type Resources = Record<string, Record<string, any>>;

const apps = [
  { id: "Backend", name: "hono-backend", authType: "IamAuth" },
  { id: "Frontend", name: "sveltekit-frontend", authType: "ApplicationManaged" },
] as const;

describe("MyStack", () => {
  let synthesized: string;
  let resource: Resources;

  /** The resources of `type` inside the LambdaWebApp construct `id`. */
  const allInApp = (type: string, id: string) =>
    Object.entries(resource[type] ?? {})
      .filter(([key]) => key.startsWith(`${id}_`))
      .map(([key, value]) => ({ ...value, address: key }));

  /** The single resource of `type` inside the LambdaWebApp construct `id`. */
  const inApp = (type: string, id: string) => {
    const matches = allInApp(type, id);
    expect(matches).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: length checked above
    return matches[0]!;
  };

  const ref = (type: string, key: string, attribute: string) => `\${${type}.${key}.${attribute}}`;

  beforeAll(async () => {
    // The stack validates these at import time and throws without them.
    process.env.UPSTASH_EMAIL = "test@example.com";
    process.env.UPSTASH_API_KEY = "test-key";
    const { MyStack } = await import("../src/stacks/my-stack.js");
    // `runValidations` makes synth fail on construct-level validation errors.
    synthesized = Testing.synth(new MyStack(new App(), "test"), true);
    resource = JSON.parse(synthesized).resource;
  }, 120_000);

  it("configures the AWS, AWS Cloud Control and Upstash providers in eu-west-1", () => {
    const provider = JSON.parse(synthesized).provider;
    expect(provider.aws[0].region).toBe("eu-west-1");
    expect(provider.awscc[0].region).toBe("eu-west-1");
    expect(Testing.toHaveProvider(synthesized, "upstash")).toBe(true);
  });

  it("creates a TLS Redis database in the same region as the functions", () => {
    expect(
      Testing.toHaveResourceWithProperties(synthesized, "upstash_redis_database", {
        database_name: "click-counter",
        region: "global",
        primary_region: "eu-west-1",
        tls: true,
      }),
    ).toBe(true);
  });

  it.each(apps)("uploads the $name package to a versioned bucket", ({ id, name }) => {
    const bucket = inApp("aws_s3_bucket", id);
    const versioning = inApp("aws_s3_bucket_versioning", id);
    const code = inApp("aws_s3_object", id);

    expect(bucket.bucket_prefix).toBe(`${name}-code-`);
    // S3 refuses to delete a bucket that still holds object versions.
    expect(bucket.force_destroy).toBe(true);
    expect(versioning.versioning_configuration.status).toBe("Enabled");
    expect(code.bucket).toBe(ref("aws_s3_bucket", bucket.address, "id"));
    expect(code.key).toBe(`${name}.zip`);
    expect(code.source).toMatch(/archive\.zip$/);
    // The asset's content hash, so only a changed package uploads a new version.
    expect(code.source_hash).toMatch(/^[0-9A-F]{32}$/);
  });

  it.each(apps)("lets only $name's revisions read its code bucket", ({ id }) => {
    const fn = inApp("awscc_lambda_web_function", id);
    const bucketPolicy = inApp("aws_s3_bucket_policy", id);
    const documents: Resources[string] = JSON.parse(synthesized).data.aws_iam_policy_document;
    const [documentKey, document] = Object.entries(documents).find(([key]) =>
      key.startsWith(`${id}_`),
    ) ?? [undefined, undefined];
    const statement = document?.statement[0];

    expect(bucketPolicy.policy).toBe(`\${data.aws_iam_policy_document.${documentKey}.json}`);
    expect(statement.principals).toEqual([
      { type: "Service", identifiers: ["lambda.amazonaws.com"] },
    ]);
    expect(statement.actions).toEqual(["s3:GetObject", "s3:GetObjectVersion"]);
    expect(statement.condition).toEqual([
      {
        test: "ArnLike",
        variable: "aws:SourceArn",
        values: [`${ref("awscc_lambda_web_function", fn.address, "function_arn")}/revision/*`],
      },
    ]);
  });

  it.each(apps)("runs $name on Node.js 24 from its pinned object version", ({ id, name }) => {
    const fn = inApp("awscc_lambda_web_function", id);
    const revision = inApp("awscc_lambda_web_function_revision", id);
    const code = inApp("aws_s3_object", id);
    const role = inApp("aws_iam_role", id);

    expect(fn.function_name).toBe(name);
    expect(revision.function_name).toBe(
      ref("awscc_lambda_web_function", fn.address, "function_name"),
    );
    expect(revision.build_config.runtime_config.runtime).toBe("nodejs24.x");
    expect(revision.build_config.code_config.s3_object.version_id).toBe(
      ref("aws_s3_object", code.address, "version_id"),
    );
    expect(revision.service_config.execution_role_arn).toBe(
      ref("aws_iam_role", role.address, "arn"),
    );
    // A replacement revision must exist before the endpoint stops routing to the old one.
    expect(revision.lifecycle.create_before_destroy).toBe(true);
  });

  it.each(apps)("routes $name's endpoint to its revision", ({ id, authType }) => {
    const fn = inApp("awscc_lambda_web_function", id);
    const revision = inApp("awscc_lambda_web_function_revision", id);
    const endpoint = inApp("awscc_lambda_web_function_endpoint", id);

    expect(endpoint.function_name).toBe(
      ref("awscc_lambda_web_function", fn.address, "function_name"),
    );
    expect(endpoint.endpoint_type).toBe("HomeRegion");
    expect(endpoint.auth_type).toBe(authType);
    expect(endpoint.revision_weights).toEqual([
      {
        revision_id: ref("awscc_lambda_web_function_revision", revision.address, "revision_id"),
        weight: 100,
      },
    ]);
  });

  it("points Lambda at the backend's .mjs bundle, and the frontend at its index.js", () => {
    const back = inApp("awscc_lambda_web_function_revision", "Backend");
    const front = inApp("awscc_lambda_web_function_revision", "Frontend");

    expect(back.service_config.environment_variables.AWS_LAMBDA_NODEJS_ENTRYPOINT).toBe(
      "index.mjs",
    );
    expect(front.service_config.environment_variables).not.toHaveProperty(
      "AWS_LAMBDA_NODEJS_ENTRYPOINT",
    );
  });

  it("passes the Redis REST URL and the token's parameter name, never the token", () => {
    const back = inApp("awscc_lambda_web_function_revision", "Backend").service_config
      .environment_variables;
    const front = inApp("awscc_lambda_web_function_revision", "Frontend").service_config
      .environment_variables;
    const backEndpoint = inApp("awscc_lambda_web_function_endpoint", "Backend");

    expect(back.UPSTASH_REDIS_REST_URL).toBe(
      `https://\${upstash_redis_database.ClickCounter.endpoint}`,
    );
    expect(back.UPSTASH_REDIS_REST_TOKEN_PARAMETER).toBe(
      `\${aws_ssm_parameter.UpstashRestToken.name}`,
    );
    expect(JSON.stringify(back)).not.toContain("rest_token");
    expect(front.BACKEND_URL).toBe(
      `https://${ref("awscc_lambda_web_function_endpoint", backEndpoint.address, "domain_name")}`,
    );
  });

  it("keeps the REST token in a SecureString only the backend can read", () => {
    const param = resource.aws_ssm_parameter?.UpstashRestToken;
    expect(param.type).toBe("SecureString");
    expect(param.value).toBe(`\${upstash_redis_database.ClickCounter.rest_token}`);

    const grant = resource.aws_iam_role_policy?.BackendReadsRestToken;
    expect(grant.role).toBe(ref("aws_iam_role", inApp("aws_iam_role", "Backend").address, "name"));
    expect(JSON.parse(grant.policy).Statement).toEqual([
      {
        Effect: "Allow",
        Action: "ssm:GetParameter",
        Resource: `\${aws_ssm_parameter.UpstashRestToken.arn}`,
      },
    ]);
  });

  it.each(apps)("logs $name to both of its log groups, which destroy removes", ({ id, name }) => {
    const groups = allInApp("aws_cloudwatch_log_group", id).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    expect(groups.map((group) => group.name)).toEqual([
      `/aws/lambda/web/${name}`,
      `/aws/lambda/web/${name}.local`,
    ]);
    for (const group of groups) expect(group.retention_in_days).toBe(7);

    const writeLogs = allInApp("aws_iam_role_policy", id).find((p) => p.name === "write-logs");
    // No logs:CreateLogGroup, so Lambda cannot recreate a group after destroy.
    expect(JSON.parse(writeLogs?.policy).Statement).toEqual([
      {
        Effect: "Allow",
        Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
        Resource: groups.map(
          (group) => `${ref("aws_cloudwatch_log_group", group.address, "arn")}:*`,
        ),
      },
    ]);
  });

  it("gives each function its own execution role", () => {
    expect(apps.map(({ id }) => inApp("aws_iam_role", id).name)).toEqual([
      "hono-backend-web-execution-role",
      "sveltekit-frontend-web-execution-role",
    ]);
    for (const { id } of apps) {
      const trust = JSON.parse(inApp("aws_iam_role", id).assume_role_policy);
      expect(trust.Statement[0].Principal).toEqual({ Service: "lambda.amazonaws.com" });
    }
    expect(Object.keys(JSON.parse(synthesized).output)).toEqual(
      expect.arrayContaining(["FrontendUrl", "BackendUrl"]),
    );
  });

  it("lets only the frontend's role invoke the backend's endpoint", () => {
    const grant = allInApp("aws_iam_role_policy", "Backend").find(
      (p) => p.name === "invoke-backend-endpoint",
    );
    const backendEndpoint = inApp("awscc_lambda_web_function_endpoint", "Backend");
    const frontendRole = inApp("aws_iam_role", "Frontend");

    expect(grant?.role).toBe(ref("aws_iam_role", frontendRole.address, "name"));
    expect(JSON.parse(grant?.policy).Statement).toEqual([
      {
        Effect: "Allow",
        Action: "lambda:InvokeWebFunctionEndpoint",
        Resource: ref(
          "awscc_lambda_web_function_endpoint",
          backendEndpoint.address,
          "endpoint_arn",
        ),
      },
    ]);
  });
});
