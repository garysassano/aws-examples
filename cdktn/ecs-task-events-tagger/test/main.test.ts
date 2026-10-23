import { App, Testing } from "cdktn";
import { describe, expect, it } from "vitest";
import { MyStack } from "../src/stacks/my-stack.js";

describe("MyStack", () => {
  // `runValidations` makes synth fail on construct-level validation errors.
  const synthesized = Testing.synth(new MyStack(new App(), "test"), true);
  const parsed = JSON.parse(synthesized);

  it("configures both providers and reads the default VPC", () => {
    expect(Testing.toHaveProvider(synthesized, "aws")).toBe(true);
    expect(Testing.toHaveProvider(synthesized, "node-lambda-packager")).toBe(true);
    expect(Testing.toHaveDataSourceWithProperties(synthesized, "aws_vpc", { default: true })).toBe(
      true,
    );
  });

  it("bundles the tagger from TypeScript source", () => {
    const pkg = parsed.data["node-lambda-packager_package"].ECSEventsTaggerPackage;

    expect(pkg.args.slice(0, 5)).toEqual([
      "--bundle",
      "--minify",
      "--sourcemap",
      "--platform=node",
      "--target=es2024",
    ]);
    // Pinned so esbuild does not pick up the CDKTN app's ES2025 tsconfig.
    expect(pkg.args[5]).toMatch(/^--tsconfig=.*\/tsconfig\.json$/);
    expect(pkg.entrypoint).toMatch(/src\/functions\/tagger\/index\.ts$/);
    expect(pkg.working_directory).toMatch(/src\/functions\/tagger$/);
  });

  it("deploys the tagger on arm64 with JSON logging", () => {
    const fn = parsed.resource.aws_lambda_function.ECSEventsTagger;

    expect(fn.function_name).toBe("ecs-events-tagger");
    expect(fn.runtime).toBe("nodejs24.x");
    expect(fn.handler).toBe("index.handler");
    expect(fn.architectures).toEqual(["arm64"]);
    expect(fn.memory_size).toBe(1024);
    expect(fn.timeout).toBe(5);
    expect(fn.logging_config).toMatchObject({ log_format: "JSON", system_log_level: "WARN" });
    expect(fn.environment.variables.POWERTOOLS_SERVICE_NAME).toBe("ecs-events-tagger");
  });

  it("wires the package output into the function", () => {
    const fn = parsed.resource.aws_lambda_function.ECSEventsTagger;

    expect(fn.filename).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Terraform interpolation, not a JS template literal
      "${data.node-lambda-packager_package.ECSEventsTaggerPackage.filename}",
    );
    expect(fn.source_code_hash).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Terraform interpolation, not a JS template literal
      "${data.node-lambda-packager_package.ECSEventsTaggerPackage.source_code_hash}",
    );
  });

  it("matches only the three ways a task fails", () => {
    const pattern = JSON.parse(
      parsed.resource.aws_cloudwatch_event_rule.ECSErroredTasksEventRule.event_pattern,
    );

    expect(pattern.source).toEqual(["aws.ecs"]);
    expect(pattern.detail.$or).toEqual([
      {
        stopCode: ["EssentialContainerExited"],
        containers: { exitCode: [{ "anything-but": 0 }] },
      },
      { stopCode: ["TaskFailedToStart"] },
      { stoppedReason: [{ wildcard: "*Error:*" }] },
    ]);
  });

  it("lets EventBridge invoke the tagger", () => {
    expect(
      Testing.toHaveResourceWithProperties(synthesized, "aws_lambda_permission", {
        action: "lambda:InvokeFunction",
        principal: "events.amazonaws.com",
      }),
    ).toBe(true);
    expect(parsed.resource.aws_cloudwatch_event_target.ECSErroredTasksEventTarget.arn).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Terraform interpolation, not a JS template literal
      "${aws_lambda_function.ECSEventsTagger.arn}",
    );
  });
});
