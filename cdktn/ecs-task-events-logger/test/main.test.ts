import { App, Testing } from "cdktn";
import { describe, expect, it } from "vitest";
import { MyStack } from "../src/stacks/my-stack.js";

describe("MyStack", () => {
  // `runValidations` makes synth fail on construct-level validation errors.
  const synthesized = Testing.synth(new MyStack(new App(), "test"), true);
  const parsed = JSON.parse(synthesized);

  it("configures the AWS provider and reads the default VPC", () => {
    expect(Testing.toHaveProvider(synthesized, "aws")).toBe(true);
    expect(Testing.toHaveDataSourceWithProperties(synthesized, "aws_vpc", { default: true })).toBe(
      true,
    );
    expect(parsed.data.aws_subnets.defaultVpcSubnets.filter[0].name).toBe("vpc-id");
  });

  it("keeps errored-task logs for a week", () => {
    expect(
      Testing.toHaveResourceWithProperties(synthesized, "aws_cloudwatch_log_group", {
        name: "/aws/events/ecs/errored-tasks",
        retention_in_days: 7,
      }),
    ).toBe(true);
  });

  it("lets EventBridge and log delivery write to that group", () => {
    const policy = JSON.parse(
      parsed.resource.aws_cloudwatch_log_resource_policy.ECSErroredTasksLogGroupPolicy
        .policy_document,
    );

    expect(policy.Statement[0].Principal.Service).toEqual([
      "delivery.logs.amazonaws.com",
      "events.amazonaws.com",
    ]);
    expect(policy.Statement[0].Action).toEqual(["logs:CreateLogStream", "logs:PutLogEvents"]);
  });

  it("matches only the three ways a task fails", () => {
    const pattern = JSON.parse(
      parsed.resource.aws_cloudwatch_event_rule.ECSErroredTasksEventRule.event_pattern,
    );

    expect(pattern.source).toEqual(["aws.ecs"]);
    expect(pattern["detail-type"]).toEqual(["ECS Task State Change"]);
    expect(pattern.detail.desiredStatus).toEqual(["STOPPED"]);
    expect(pattern.detail.$or).toEqual([
      {
        stopCode: ["EssentialContainerExited"],
        containers: { exitCode: [{ "anything-but": 0 }] },
      },
      { stopCode: ["TaskFailedToStart"] },
      { stoppedReason: [{ wildcard: "*Error:*" }] },
    ]);
  });

  it("sends matched events to the log group", () => {
    const target = parsed.resource.aws_cloudwatch_event_target.ECSErroredTasksEventTarget;
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Terraform interpolation, not a JS template literal
    const ruleRef = "${aws_cloudwatch_event_rule.ECSErroredTasksEventRule.name}";
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Terraform interpolation, not a JS template literal
    const groupArnRef = "${aws_cloudwatch_log_group.ECSErroredTasksLogGroup.arn}";

    expect(target.rule).toBe(ruleRef);
    expect(target.arn).toBe(groupArnRef);
  });

  it("runs a Fargate task that is expected to fail", () => {
    const task = parsed.resource.aws_ecs_task_definition.ECSTask;

    expect(task.requires_compatibilities).toEqual(["FARGATE"]);
    expect(task.network_mode).toBe("awsvpc");
    expect(JSON.parse(task.container_definitions)[0].image).toBe("unexisting-image");

    expect(
      Testing.toHaveResourceWithProperties(synthesized, "aws_ecs_service", {
        name: "ecs-service",
        launch_type: "FARGATE",
        desired_count: 1,
      }),
    ).toBe(true);
  });
});
