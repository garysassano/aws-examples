import { App, Testing } from "cdktn";
import { describe, expect, it } from "vitest";
import { MyStack } from "../src/stacks/my-stack.js";

describe("MyStack", () => {
  // `runValidations` makes synth fail on construct-level validation errors.
  const synthesized = Testing.synth(new MyStack(new App(), "test"), true);
  const { data, resource } = JSON.parse(synthesized);

  it("runs a Fargate task that always fails, with no execution role", () => {
    const task = resource.aws_ecs_task_definition.FailingTask;
    const [container] = JSON.parse(task.container_definitions);

    expect(task.runtime_platform.cpu_architecture).toBe("ARM64");
    expect(task.execution_role_arn).toBeUndefined();
    expect(task.tags).toEqual({ project: "example", environment: "dev", owner: "someone" });
    expect(container).toMatchObject({ command: ["false"], essential: true });
    expect(resource.aws_ecs_service.FailingService.desired_count).toBe(1);
  });

  it("matches only the three ways a task fails", () => {
    const pattern = JSON.parse(resource.aws_cloudwatch_event_rule.ErroredTasks.event_pattern);

    expect(pattern.source).toEqual(["aws.ecs"]);
    expect(pattern.detail.$or).toEqual([
      {
        stopCode: ["EssentialContainerExited"],
        containers: { exitCode: [{ "anything-but": 0 }] },
      },
      { stopCode: ["TaskFailedToStart"] },
      { stoppedReason: [{ wildcard: "*Error:*" }, { wildcard: "*Exception:*" }] },
    ]);
  });

  it("sends each event to both the raw log group and the tagger", () => {
    const targets = resource.aws_cloudwatch_event_target;

    expect(targets.ErroredTasksToRawEvents.arn).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Terraform interpolation
      "${aws_cloudwatch_log_group.RawEvents.arn}",
    );
    expect(targets.ErroredTasksToTagger.arn).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Terraform interpolation
      "${aws_lambda_function.Tagger.arn}",
    );
    expect(resource.aws_lambda_permission.RuleInvokesTagger).toMatchObject({
      principal: "events.amazonaws.com",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Terraform interpolation
      source_arn: "${aws_cloudwatch_event_rule.ErroredTasks.arn}",
    });
  });

  it("lets EventBridge write to the raw log group through a policy on that group", () => {
    const policy = resource.aws_cloudwatch_log_resource_policy.RawEventsPolicy;

    expect(policy.policy_name).toBeUndefined();
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Terraform interpolation
    expect(policy.resource_arn).toBe("${aws_cloudwatch_log_group.RawEvents.arn}");
  });

  it("bundles the tagger for Node.js 24 on arm64", () => {
    const pkg = data["node-lambda-packager_package"].TaggerPackage;
    const fn = resource.aws_lambda_function.Tagger;

    expect(pkg.args).toContain("--target=node24");
    expect(pkg.entrypoint).toMatch(/src\/functions\/tagger\/index\.ts$/);
    expect(fn).toMatchObject({ runtime: "nodejs24.x", architectures: ["arm64"] });
    expect(fn.logging_config).toMatchObject({ log_format: "JSON", system_log_level: "WARN" });
  });
});
