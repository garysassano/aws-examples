import { type CfnRole, Role } from "aws-cdk-lib/aws-iam";
import { Function as LambdaFunction } from "aws-cdk-lib/aws-lambda";
import { type IAspect, Token } from "aws-cdk-lib/core";
import type { IConstruct } from "constructs";

const POLICY_NAME = "deny-log-group-creation";

/**
 * Denies `logs:CreateLogGroup` to the role of every Lambda function.
 *
 * Lambda delivers an invocation's logs a few seconds after it ends, using the function's role. If
 * the stack deletes the log group in that window, the delivery recreates it outside the stack,
 * where it never expires and, when it has a fixed name, makes the next deploy fail. Each function's
 * log group belongs to the stack, so its role never needs to create one.
 *
 * The deny goes in the role's own policies rather than a separate policy resource, which
 * CloudFormation deletes before the role, so it lasts exactly as long as the role.
 */
export class DenyLogGroupCreation implements IAspect {
  visit(node: IConstruct): void {
    if (!(node instanceof LambdaFunction) || !(node.role instanceof Role)) return;
    const cfnRole = node.role.node.defaultChild as CfnRole;
    const policies = cfnRole.policies ?? [];
    if (Token.isUnresolved(policies) || !Array.isArray(policies)) {
      throw new Error(
        `Cannot add ${POLICY_NAME} to ${node.role.node.path}: its policies are a token`,
      );
    }
    const hasDeny = policies.some(
      (policy) =>
        !Token.isUnresolved(policy) &&
        (policy as CfnRole.PolicyProperty).policyName === POLICY_NAME,
    );
    if (hasDeny) return; // Functions can share a role
    cfnRole.policies = [
      ...policies,
      {
        policyName: POLICY_NAME,
        policyDocument: {
          Version: "2012-10-17",
          Statement: [{ Effect: "Deny", Action: "logs:CreateLogGroup", Resource: "*" }],
        },
      },
    ];
  }
}
