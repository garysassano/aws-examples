import { join } from "node:path";
import { ManagedPolicy } from "aws-cdk-lib/aws-iam";
import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib/core";
import type { Construct } from "constructs";
import { WebFunction } from "../constructs/web-function.js";

export class MyStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    // MCP server over stateless Streamable HTTP. Its endpoint uses IamAuth, so Lambda only
    // forwards requests signed with SigV4 by a principal allowed to invoke it.
    const mcpServer = new WebFunction(this, "McpServer", {
      functionName: "lambda-web-mcp-server",
      entry: join(import.meta.dirname, "../functions/mcp-server/index.ts"),
      authType: "IamAuth",
      // Long enough for the largest count_primes call while other requests share the CPU.
      timeout: Duration.minutes(5),
    });

    // Principals in this account with broad Lambda permissions, such as administrators, can
    // already call the server. Attach this policy to any other role or user that should.
    const invokePolicy = new ManagedPolicy(this, "InvokeMcpServer", {
      description: "Allows calling the lambda-web-mcp-server endpoint",
    });
    mcpServer.grantInvoke(invokePolicy);

    new CfnOutput(this, "McpServerUrl", {
      value: `${mcpServer.url}/mcp`,
      description: "MCP endpoint URL, for mcp-proxy-for-aws",
    });
    new CfnOutput(this, "InvokePolicyArn", {
      value: invokePolicy.managedPolicyArn,
      description: "Managed policy that allows calling the MCP server",
    });
  }
}
