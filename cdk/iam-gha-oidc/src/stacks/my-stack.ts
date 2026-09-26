import {
  type Conditions,
  Effect,
  OpenIdConnectProvider,
  PolicyDocument,
  PolicyStatement,
  Role,
  WebIdentityPrincipal,
} from "aws-cdk-lib/aws-iam";
import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib/core";
import type { Construct } from "constructs";

export class MyStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const ghaOidcProvider = new OpenIdConnectProvider(this, "GhaOidcProvider", {
      url: "https://token.actions.githubusercontent.com",
      clientIds: ["sts.amazonaws.com"],
    });

    const ghaOidcClaims: Conditions = {
      StringEquals: {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      },
      StringLike: {
        "token.actions.githubusercontent.com:sub": "repo:gh-owner/gh-repo:*",
      },
    };

    const ghaOidcRole = new Role(this, "GhaOidcRole", {
      roleName: "GhaOidcRole",
      assumedBy: new WebIdentityPrincipal(ghaOidcProvider.openIdConnectProviderArn, ghaOidcClaims),
      inlinePolicies: {
        AssumeCdkRoles: new PolicyDocument({
          statements: [
            // Allow assuming roles provisioned by the CDK bootstrap stack
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ["sts:AssumeRole"],
              resources: [`arn:aws:iam::${this.account}:role/cdk-*`],
            }),
          ],
        }),
      },
    });

    new CfnOutput(this, "GhaOidcRoleArn", {
      value: ghaOidcRole.roleArn,
    });
  }
}
