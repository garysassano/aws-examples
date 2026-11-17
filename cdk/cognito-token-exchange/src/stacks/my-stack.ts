import path from "node:path";
import { HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import {
  type CfnUserPoolClient,
  FeaturePlan,
  LambdaVersion,
  OAuthScope,
  ResourceServerScope,
  UserPool,
  UserPoolOperation,
} from "aws-cdk-lib/aws-cognito";
import { Architecture, LoggingFormat, Runtime } from "aws-cdk-lib/aws-lambda";
import {
  NodejsFunction,
  type NodejsFunctionProps,
  OutputFormat,
} from "aws-cdk-lib/aws-lambda-nodejs";
import {
  CfnOutput,
  Fn,
  RemovalPolicy,
  Stack,
  type StackProps,
  Validations,
} from "aws-cdk-lib/core";
import type { Construct } from "constructs";
import { ORDERS_RESOURCE_SERVER } from "../constants.js";

const functionDefaults: Partial<NodejsFunctionProps> = {
  runtime: Runtime.NODEJS_24_X,
  architecture: Architecture.ARM_64,
  loggingFormat: LoggingFormat.JSON,
  bundling: {
    format: OutputFormat.ESM,
    mainFields: ["module", "main"],
    minify: true,
  },
};

const entry = (name: string) => path.join(import.meta.dirname, "..", "functions", name, "index.ts");

export class MyStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    // Token exchange and access token customization both need the Essentials or Plus plan.
    const userPool = new UserPool(this, "UserPool", {
      featurePlan: FeaturePlan.ESSENTIALS,
      selfSignUpEnabled: false,
      signInAliases: { username: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Tokens from API sign-in only carry `aws.cognito.signin.user.admin`, so this trigger adds the
    // orders scopes that the user's token needs before it can be exchanged for them.
    const preTokenGeneration = new NodejsFunction(this, "PreTokenGeneration", {
      ...functionDefaults,
      entry: entry("pre-token-generation"),
    });
    userPool.addTrigger(
      UserPoolOperation.PRE_TOKEN_GENERATION_CONFIG,
      preTokenGeneration,
      LambdaVersion.V2_0,
    );

    const readScope = new ResourceServerScope({
      scopeName: "read",
      scopeDescription: "Read orders",
    });
    const writeScope = new ResourceServerScope({
      scopeName: "write",
      scopeDescription: "Create and change orders",
    });
    const ordersServer = userPool.addResourceServer("OrdersResourceServer", {
      identifier: ORDERS_RESOURCE_SERVER,
      scopes: [readScope, writeScope],
    });

    // The app that users sign in to. It has no secret and signs users in through the user pools API.
    const appClient = userPool.addClient("AppClient", {
      authFlows: { userPassword: true },
      disableOAuth: true,
    });

    // The agent's own identity. Its client-credentials token is the actor token, and the scopes it
    // may issue cap what any exchange can grant, so it can never get `orders/write`.
    const agentClient = userPool.addClient("AgentClient", {
      generateSecret: true,
      oAuth: {
        flows: { clientCredentials: true },
        scopes: [OAuthScope.resourceServer(ordersServer, readScope)],
      },
    });
    // The L2 construct has no option for the token-exchange flows yet, and the CloudFormation
    // Validate schemas bundled with aws-cdk-lib don't list them.
    const cfnAgentClient = agentClient.node.defaultChild as CfnUserPoolClient;
    cfnAgentClient.explicitAuthFlows = ["ALLOW_TOKEN_EXCHANGE_DELEGATION"];
    Validations.of(cfnAgentClient).acknowledge({
      id: "CloudFormation-Validate::W3030",
      reason: "The bundled schemas predate the token-exchange flows",
    });

    // The agent gets its actor token from the token endpoint, which needs a domain. Prefixes are
    // unique per Region, so this one ends with part of the stack's ID.
    const stackIdSuffix = Fn.select(4, Fn.split("-", Fn.select(2, Fn.split("/", this.stackId))));
    const domain = userPool.addDomain("Domain", {
      cognitoDomain: { domainPrefix: `token-exchange-${stackIdSuffix}` },
    });

    const issuer = userPool.userPoolProviderUrl;

    // Orders API: the downstream service. It accepts only tokens bound to the orders audience.
    const ordersFunction = new NodejsFunction(this, "OrdersFunction", {
      ...functionDefaults,
      entry: entry("orders"),
    });
    const ordersApi = new HttpApi(this, "OrdersApi");
    ordersApi.addRoutes({
      path: "/orders",
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration("OrdersIntegration", ordersFunction),
      authorizer: new HttpJwtAuthorizer("OrdersAuthorizer", issuer, {
        jwtAudience: [ORDERS_RESOURCE_SERVER],
      }),
      authorizationScopes: [`${ORDERS_RESOURCE_SERVER}/${readScope.scopeName}`],
    });

    // Agent API: takes the user's token, exchanges it, and calls the orders API on their behalf.
    const agentFunction = new NodejsFunction(this, "AgentFunction", {
      ...functionDefaults,
      entry: entry("agent"),
      // GetDerivedToken is newer than the SDK in the Lambda runtime.
      bundling: { ...functionDefaults.bundling, bundleAwsSDK: true },
      environment: {
        USER_POOL_ID: userPool.userPoolId,
        AGENT_CLIENT_ID: agentClient.userPoolClientId,
        TOKEN_ENDPOINT: `${domain.baseUrl()}/oauth2/token`,
        ORDERS_API_URL: ordersApi.apiEndpoint,
      },
    });
    // To read the agent client's secret at startup
    userPool.grant(agentFunction, "cognito-idp:DescribeUserPoolClient");

    const agentApi = new HttpApi(this, "AgentApi");
    agentApi.addRoutes({
      path: "/orders",
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration("AgentIntegration", agentFunction),
      // A user's access token from the app client. Its `client_id` is the audience, and the scope
      // rules out the ID token, which has the same audience.
      authorizer: new HttpJwtAuthorizer("AgentAuthorizer", issuer, {
        jwtAudience: [appClient.userPoolClientId],
      }),
      authorizationScopes: ["aws.cognito.signin.user.admin"],
    });

    new CfnOutput(this, "Region", { value: this.region });
    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "AppClientId", { value: appClient.userPoolClientId });
    new CfnOutput(this, "AgentApiUrl", { value: agentApi.apiEndpoint });
    new CfnOutput(this, "OrdersApiUrl", { value: ordersApi.apiEndpoint });
  }
}
