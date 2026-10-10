import {
  CfnScalingPolicy,
  ScalableTarget,
  ServiceNamespace,
} from "aws-cdk-lib/aws-applicationautoscaling";
import { Stack, type StackProps } from "aws-cdk-lib/core";
import type { Construct } from "constructs";
import { ScalableFunction } from "../constructs/scalable-function.js";

export class LambdaDPCAdvanced extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    const { function: fn, alias } = new ScalableFunction(this, "ScalableFunction", {
      functionName: "dpc-advanced",
    });

    // Register the alias provisioned concurrency as a scalable target
    const scalableTarget = new ScalableTarget(this, "ScalableTarget", {
      serviceNamespace: ServiceNamespace.LAMBDA,
      resourceId: `function:${fn.functionName}:${alias.aliasName}`,
      scalableDimension: "lambda:function:ProvisionedConcurrency",
      minCapacity: 1,
      maxCapacity: 5,
    });
    // The resource ID is a plain string, so CloudFormation cannot infer the alias dependency
    scalableTarget.node.addDependency(alias);

    // The L2 scaling policy accepts a single metric only, so the metric math goes through L1
    new CfnScalingPolicy(this, "UtilizationTracking", {
      policyName: "ProvisionedConcurrencyUtilization",
      policyType: "TargetTrackingScaling",
      scalingTargetId: scalableTarget.scalableTargetId,
      targetTrackingScalingPolicyConfiguration: {
        targetValue: 0.7,
        customizedMetricSpecification: {
          metrics: [
            {
              id: "utilization",
              // Maximum catches short bursts that the predefined metric's Average smooths out
              metricStat: {
                metric: {
                  namespace: "AWS/Lambda",
                  metricName: "ProvisionedConcurrencyUtilization",
                  dimensions: [
                    { name: "FunctionName", value: fn.functionName },
                    { name: "Resource", value: `${fn.functionName}:${alias.aliasName}` },
                  ],
                },
                stat: "Maximum",
              },
              returnData: false,
            },
            {
              id: "utilizationOrZero",
              // Lambda emits no datapoints while idle, which leaves the alarms in INSUFFICIENT_DATA
              // and blocks scale-in; reading the gaps as 0 lets capacity fall back to the minimum
              expression: "FILL(utilization, 0)",
              label: "ProvisionedConcurrencyUtilization (Maximum, idle as 0)",
              returnData: true,
            },
          ],
        },
      },
    });
  }
}
