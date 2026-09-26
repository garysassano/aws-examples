import { App, Testing } from "cdktn";
import { describe, expect, it } from "vitest";
import { MyStack } from "../src/stacks/my-stack.js";

describe("MyStack", () => {
  // `runValidations` makes synth fail on construct-level validation errors.
  const synthesized = Testing.synth(new MyStack(new App(), "test"), true);
  const parsed = JSON.parse(synthesized);

  it("configures both providers", () => {
    expect(Testing.toHaveProvider(synthesized, "aws")).toBe(true);
    expect(Testing.toHaveProvider(synthesized, "node-lambda-packager")).toBe(true);
  });

  it("gives the function a role Lambda can assume", () => {
    const policy = JSON.parse(parsed.resource.aws_iam_role.LambdaRole.assume_role_policy);

    expect(policy.Statement[0].Principal.Service).toBe("lambda.amazonaws.com");
    expect(policy.Statement[0].Action).toBe("sts:AssumeRole");
    expect(
      Testing.toHaveResourceWithProperties(synthesized, "aws_iam_role_policy_attachment", {
        policy_arn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
      }),
    ).toBe(true);
  });

  it("bundles the function from TypeScript source", () => {
    const pkg = parsed.data["node-lambda-packager_package"].SampleLambdaPackage;

    expect(pkg.args.slice(0, 5)).toEqual([
      "--bundle",
      "--minify",
      "--sourcemap",
      "--platform=node",
      "--target=es2024",
    ]);
    // Pinned so esbuild does not pick up the CDKTN app's ES2025 tsconfig.
    expect(pkg.args[5]).toMatch(/^--tsconfig=.*\/tsconfig\.json$/);
    expect(pkg.entrypoint).toMatch(/src\/functions\/sample\/index\.ts$/);
    expect(pkg.working_directory).toMatch(/src\/functions\/sample$/);
  });

  it("deploys the function on arm64 with JSON logging", () => {
    const fn = parsed.resource.aws_lambda_function.SampleLambda;

    expect(fn.function_name).toBe("sample-lambda");
    expect(fn.runtime).toBe("nodejs24.x");
    expect(fn.handler).toBe("index.handler");
    expect(fn.architectures).toEqual(["arm64"]);
    expect(fn.memory_size).toBe(1024);
    expect(fn.timeout).toBe(1);
    expect(fn.logging_config).toMatchObject({ log_format: "JSON" });
  });

  it("wires the package output into the function", () => {
    const fn = parsed.resource.aws_lambda_function.SampleLambda;

    expect(fn.filename).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Terraform interpolation, not a JS template literal
      "${data.node-lambda-packager_package.SampleLambdaPackage.filename}",
    );
    expect(fn.source_code_hash).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Terraform interpolation, not a JS template literal
      "${data.node-lambda-packager_package.SampleLambdaPackage.source_code_hash}",
    );
  });
});
