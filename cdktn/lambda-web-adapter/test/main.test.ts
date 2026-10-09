import { App, Testing } from "cdktn";
import { beforeAll, describe, expect, it } from "vitest";

// biome-ignore lint/suspicious/noExplicitAny: synthesized Terraform JSON
type Resources = Record<string, Record<string, any>>;

const apps = [
  { id: "Back", dir: "back" },
  { id: "Front", dir: "front" },
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
        database_name: "redis-database",
        region: "global",
        primary_region: "eu-central-1",
        tls: true,
      }),
    ).toBe(true);
  });

  it.each(apps)("lets destroy remove the $dir image repository", ({ id, dir }) => {
    const repo = inApp("aws_ecr_repository", id);

    expect(repo.name).toBe(`${dir}-repo`);
    // ECR refuses to delete a non-empty repository, and this stack always pushes an image.
    expect(repo.force_delete).toBe(true);
  });

  it.each(apps)("builds the $dir image for arm64 and rebuilds it on change", ({ id, dir }) => {
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

  it.each(apps)("deploys the $dir Lambda from its pushed image digest", ({ id, dir }) => {
    const fn = inApp("aws_lambda_function", id);
    const push = inApp("docker_registry_image", id);

    expect(fn.function_name).toBe(`${dir}-lambda`);
    expect(fn.package_type).toBe("Image");
    expect(fn.architectures).toEqual(["arm64"]);
    expect(fn.memory_size).toBe(1769);
    expect(fn.image_uri).toBe(
      `\${docker_registry_image.${push.key}.name}@\${docker_registry_image.${push.key}.sha256_digest}`,
    );
  });

  it("passes the Redis REST endpoint to the backend and the backend URL to the frontend", () => {
    const back = inApp("aws_lambda_function", "Back").environment.variables;
    const front = inApp("aws_lambda_function", "Front").environment.variables;
    const backUrl = inApp("aws_lambda_function_url", "Back");

    expect(back.UPSTASH_REDIS_REST_URL).toBe(
      `https://\${upstash_redis_database.RedisDatabase.endpoint}`,
    );
    expect(back.UPSTASH_REDIS_REST_TOKEN).toBe(
      `\${upstash_redis_database.RedisDatabase.rest_token}`,
    );
    expect(front.BACKEND_URL).toBe(`\${aws_lambda_function_url.${backUrl.key}.function_url}`);
  });

  it("exposes both Lambdas over unauthenticated function URLs", () => {
    for (const { id } of apps) {
      expect(inApp("aws_lambda_function_url", id).authorization_type).toBe("NONE");
    }
    expect(Object.keys(JSON.parse(synthesized).output)).toEqual(
      expect.arrayContaining(["FrontLambdaURL", "BackLambdaURL"]),
    );
  });
});
