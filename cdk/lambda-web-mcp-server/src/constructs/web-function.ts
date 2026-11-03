import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Grant,
  type IGrantable,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import {
  CfnWebFunction,
  CfnWebFunctionEndpoint,
  CfnWebFunctionRevision,
} from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { BlockPublicAccess, Bucket } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import { type Duration, Fn, RemovalPolicy, Validations } from "aws-cdk-lib/core";
import { Construct } from "constructs";
import { buildSync } from "esbuild";

export interface WebFunctionProps {
  /** Name of the Web Function, which also names its log groups. */
  readonly functionName: string;
  /** TypeScript entry file of the web server, bundled with esbuild at synth. */
  readonly entry: string;
  /**
   * Who may call the endpoint: anyone (`ApplicationManaged`), or only IAM principals
   * that sign their requests with SigV4 and are allowed to (`IamAuth`, see `grantInvoke`).
   */
  readonly authType: "ApplicationManaged" | "IamAuth";
  /** How long a request may run, up to 15 minutes. */
  readonly timeout: Duration;
  readonly environment?: Record<string, string>;
}

/**
 * A Node web server, run as a Lambda Web Function with its own execution role, and exposed
 * over one HTTPS endpoint in the stack's Region.
 *
 * aws-cdk-lib has only L1 constructs for Web Functions.
 */
export class WebFunction extends Construct {
  readonly role: Role;
  readonly function: CfnWebFunction;
  readonly revision: CfnWebFunctionRevision;
  readonly endpoint: CfnWebFunctionEndpoint;

  constructor(scope: Construct, id: string, props: WebFunctionProps) {
    super(scope, id);

    // Lambda writes logs to `<name>.local` in each Region that serves traffic, then copies
    // them to `<name>` in the home Region. Both are declared, so they expire and are deleted
    // with the stack, and the role can't create them again.
    const logGroupName = `/aws/lambda/web/${props.functionName}`;
    const logGroups = [logGroupName, `${logGroupName}.local`].map(
      (name, i) =>
        new LogGroup(this, i === 0 ? "LogGroup" : "LocalLogGroup", {
          logGroupName: name,
          retention: RetentionDays.ONE_WEEK,
        }),
    );

    // The logging permissions are inline, so they are deleted with the role, never before it.
    this.role = new Role(this, "ExecutionRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      inlinePolicies: {
        WriteLogs: new PolicyDocument({
          statements: [
            new PolicyStatement({
              actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
              // The log group ARN ends in `:*`, which covers its log streams.
              resources: logGroups.map((logGroup) => logGroup.logGroupArn),
            }),
          ],
        }),
      },
    });

    this.function = new CfnWebFunction(this, "Function", { functionName: props.functionName });

    // Web Functions take code only as a .zip in a versioned S3 bucket that Lambda can read as
    // its own service principal, which rules out the CDK bootstrap bucket.
    const bucket = new Bucket(this, "CodeBucket", {
      versioned: true,
      enforceSSL: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    bucket.addToResourcePolicy(
      new PolicyStatement({
        principals: [new ServicePrincipal("lambda.amazonaws.com")],
        actions: ["s3:GetObject", "s3:GetObjectVersion"],
        resources: [bucket.arnForObjects("*")],
        conditions: { ArnLike: { "aws:SourceArn": `${this.function.attrFunctionArn}/revision/*` } },
      }),
    );

    // The bundle is built at synth, as NodejsFunction does. Its asset hash changes only with
    // its contents, so an unchanged server uploads nothing and keeps its revision.
    const outdir = mkdtempSync(join(tmpdir(), "web-function-"));
    buildSync({
      entryPoints: [props.entry],
      outfile: join(outdir, "index.mjs"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      mainFields: ["module", "main"],
      minify: true,
      sourcemap: true,
      banner: { js: "process.setSourceMapsEnabled(true);" },
      logLevel: "error",
    });
    const code = new BucketDeployment(this, "Code", {
      sources: [Source.asset(outdir)],
      destinationBucket: bucket,
      extract: false,
    });

    const environment = { ...props.environment, AWS_LAMBDA_NODEJS_ENTRYPOINT: "index.mjs" };

    // A revision is immutable, so any change replaces it. CloudFormation creates the new one
    // and points the endpoint at it before it deletes the old one.
    this.revision = new CfnWebFunctionRevision(this, "Revision", {
      functionName: this.function.functionName,
      buildConfig: {
        codeConfig: {
          s3Object: {
            bucket: bucket.bucketName,
            key: Fn.select(0, code.objectKeys),
            versionId: Fn.select(0, code.objectVersionIds),
          },
        },
        runtimeConfig: { runtime: "nodejs24.x" },
      },
      serviceConfig: {
        executionRoleArn: this.role.roleArn,
        timeoutSeconds: props.timeout.toSeconds(),
        environmentVariables: environment,
      },
    });
    // Lambda checks that it can read the package when the revision is created.
    if (bucket.policy) this.revision.node.addDependency(bucket.policy);
    this.revision.node.addDependency(this.function);

    this.endpoint = new CfnWebFunctionEndpoint(this, "Endpoint", {
      functionName: this.function.functionName,
      endpointName: "live",
      endpointType: "HomeRegion",
      authType: props.authType,
      revisionWeights: [{ revisionId: this.revision.attrRevisionId, weight: 100 }],
    });
    this.endpoint.node.addDependency(this.function);

    // The CloudFormation Validate schemas bundled with aws-cdk-lib 2.275.0 predate Web
    // Functions.
    for (const resource of [this.function, this.revision, this.endpoint]) {
      Validations.of(resource).acknowledge({
        id: "CloudFormation-Validate::F3006",
        reason: "Web Function resource types are missing from the bundled schemas",
      });
    }
  }

  /** HTTPS URL of the endpoint. */
  get url(): string {
    return `https://${this.endpoint.attrDomainName}`;
  }

  /**
   * Lets a principal call an `IamAuth` endpoint. A principal in the same account needs only
   * this identity-based grant, not a resource-based policy on the function.
   */
  grantInvoke(grantee: IGrantable): Grant {
    return Grant.addToPrincipal({
      grantee,
      actions: ["lambda:InvokeWebFunctionEndpoint"],
      resourceArns: [this.endpoint.attrEndpointArn],
    });
  }
}
