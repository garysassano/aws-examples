import { Stack, type StackProps } from "aws-cdk-lib/core";
import type { Construct } from "constructs";
import { ScalableFunction } from "../constructs/scalable-function.js";

export class LambdaDPCBasic extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    const { alias } = new ScalableFunction(this, "ScalableFunction", {
      functionName: "dpc-basic",
    });

    // Register the alias provisioned concurrency as a scalable target
    const scalableTarget = alias.addAutoScaling({
      minCapacity: 1,
      maxCapacity: 5,
    });

    // Target tracking on the predefined metric, which uses the Average statistic
    scalableTarget.scaleOnUtilization({
      utilizationTarget: 0.7,
    });
  }
}
