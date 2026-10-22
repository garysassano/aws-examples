import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { AssetType, TerraformAsset } from "cdktn";
import { Construct } from "constructs";
import { CloudwatchLogGroup } from "../../.gen/providers/aws/cloudwatch-log-group/index.js";
import { IamRole } from "../../.gen/providers/aws/iam-role/index.js";
import { IamRolePolicy } from "../../.gen/providers/aws/iam-role-policy/index.js";
import { S3Bucket } from "../../.gen/providers/aws/s3-bucket/index.js";
import { S3BucketPolicy } from "../../.gen/providers/aws/s3-bucket-policy/index.js";
import { S3BucketVersioningA } from "../../.gen/providers/aws/s3-bucket-versioning/index.js";
import { S3Object } from "../../.gen/providers/aws/s3-object/index.js";
import { LambdaWebFunction } from "../../.gen/providers/awscc/lambda-web-function/index.js";
import { LambdaWebFunctionEndpoint } from "../../.gen/providers/awscc/lambda-web-function-endpoint/index.js";
import { LambdaWebFunctionRevision } from "../../.gen/providers/awscc/lambda-web-function-revision/index.js";
import { hashSource } from "../utils/hash-source.js";

export interface LambdaWebAppProps {
  /** Name of the web function, and prefix of its execution role and code bucket. */
  readonly name: string;
  /** Standalone pnpm project whose `build` script writes the deployment package to `dist/`. */
  readonly codeDir: string;
  /** Entry file in `dist/`, when it is not `index.js`. */
  readonly entrypoint?: string;
  /**
   * Who may call the endpoint: anyone (`ApplicationManaged`), or only IAM principals
   * that sign their requests with SigV4 and are allowed to (`IamAuth`, see `grantInvoke`).
   */
  readonly authType: "ApplicationManaged" | "IamAuth";
  readonly environment?: Record<string, string>;
}

/** Runs a command, and fails synth with its output when the command fails. */
function run(command: string, args: string[], cwd: string, env: Record<string, string> = {}) {
  try {
    execFileSync(command, args, {
      cwd,
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error) {
    const { stdout = "", stderr = "" } = error as { stdout?: string; stderr?: string };
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd}\n${stdout}${stderr}`);
  }
}

/**
 * A Node web server, run as a Lambda Web Function with its own execution role, and
 * exposed over one HTTPS endpoint in the stack's Region.
 */
export class LambdaWebApp extends Construct {
  readonly role: IamRole;
  readonly function: LambdaWebFunction;
  readonly revision: LambdaWebFunctionRevision;
  readonly endpoint: LambdaWebFunctionEndpoint;

  constructor(scope: Construct, id: string, props: LambdaWebAppProps) {
    super(scope, id);

    // Web Functions take only a .zip in S3, so the package is built at synth, as
    // NodejsFunction bundles in AWS CDK. The source hash versions the SvelteKit build,
    // so unchanged source builds a byte-identical package and nothing is redeployed.
    run("pnpm", ["install", "--frozen-lockfile"], props.codeDir);
    run("pnpm", ["build"], props.codeDir, { APP_VERSION: hashSource(props.codeDir) });
    const pkg = new TerraformAsset(this, "Package", {
      path: join(props.codeDir, "dist"),
      type: AssetType.ARCHIVE,
    });

    this.role = new IamRole(this, "ExecutionRole", {
      // IAM names are global, so this one differs from the lambda-web-adapter example's.
      name: `${props.name}-web-execution-role`,
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "lambda.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      }),
    });

    // Lambda writes logs to `<name>.local` in each Region that serves traffic, then
    // copies them to `<name>` in the home Region. Both are declared rather than left
    // for Lambda to create, so destroy removes them and their logs expire.
    const logGroupName = `/aws/lambda/web/${props.name}`;
    const logGroup = new CloudwatchLogGroup(this, "LogGroup", {
      name: logGroupName,
      retentionInDays: 7,
    });
    const localLogGroup = new CloudwatchLogGroup(this, "LocalLogGroup", {
      name: `${logGroupName}.local`,
      retentionInDays: 7,
    });
    // Without logs:CreateLogGroup, Lambda cannot recreate the groups after a destroy.
    const writeLogs = new IamRolePolicy(this, "WriteLogs", {
      name: "write-logs",
      role: this.role.name,
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
            Resource: [`${logGroup.arn}:*`, `${localLogGroup.arn}:*`],
          },
        ],
      }),
    });

    // Lambda pins each revision to an object version, so the bucket must be versioned.
    const bucket = new S3Bucket(this, "CodeBucket", {
      bucketPrefix: `${props.name}-code-`,
      // S3 refuses to delete a bucket that still holds object versions.
      forceDestroy: true,
    });
    const versioning = new S3BucketVersioningA(this, "CodeBucketVersioning", {
      bucket: bucket.id,
      versioningConfiguration: { status: "Enabled" },
    });

    this.function = new LambdaWebFunction(this, "Function", { functionName: props.name });

    // Lambda reads the package as its own service principal, and only for this
    // function's revisions. Nothing may reach the bucket over plain HTTP.
    const bucketPolicy = new S3BucketPolicy(this, "CodeBucketPolicy", {
      bucket: bucket.id,
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "lambda.amazonaws.com" },
            Action: ["s3:GetObject", "s3:GetObjectVersion"],
            Resource: `${bucket.arn}/*`,
            Condition: { ArnLike: { "aws:SourceArn": `${this.function.functionArn}/revision/*` } },
          },
          {
            Effect: "Deny",
            Principal: "*",
            Action: "s3:*",
            Resource: [bucket.arn, `${bucket.arn}/*`],
            Condition: { Bool: { "aws:SecureTransport": "false" } },
          },
        ],
      }),
    });

    // The asset hash covers the package's contents, so a changed package, and only a
    // changed package, uploads a new object version.
    const code = new S3Object(this, "Code", {
      bucket: bucket.id,
      key: `${props.name}.zip`,
      source: pkg.path,
      sourceHash: pkg.assetHash,
      dependsOn: [versioning],
    });

    const environment = {
      ...props.environment,
      ...(props.entrypoint && { AWS_LAMBDA_NODEJS_ENTRYPOINT: props.entrypoint }),
    };

    // A revision is immutable, so every change replaces it. The new one is created
    // before the old one is deleted, so the endpoint always routes to a live revision.
    this.revision = new LambdaWebFunctionRevision(this, "Revision", {
      functionName: this.function.functionName,
      buildConfig: {
        codeConfig: {
          s3Object: { bucket: code.bucket, key: code.key, versionId: code.versionId },
        },
        runtimeConfig: { runtime: "nodejs24.x" },
      },
      serviceConfig: {
        executionRoleArn: this.role.arn,
        timeoutSeconds: 10,
        environmentVariables: Object.keys(environment).length > 0 ? environment : undefined,
      },
      lifecycle: { createBeforeDestroy: true },
      dependsOn: [bucketPolicy, writeLogs],
    });

    this.endpoint = new LambdaWebFunctionEndpoint(this, "Endpoint", {
      functionName: this.function.functionName,
      endpointName: "live",
      endpointType: "HomeRegion",
      authType: props.authType,
      revisionWeights: [{ revisionId: this.revision.revisionId, weight: 100 }],
    });
  }

  /** HTTPS URL of the endpoint. */
  get url(): string {
    return `https://${this.endpoint.domainName}`;
  }

  /**
   * Lets another app's execution role call this app's `IamAuth` endpoint. A caller in
   * the same account needs only this identity-based grant, not a resource-based policy.
   */
  grantInvoke(caller: LambdaWebApp): void {
    new IamRolePolicy(this, `${caller.node.id}Invoke`, {
      name: `invoke-${this.node.id.toLowerCase()}-endpoint`,
      role: caller.role.name,
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: "lambda:InvokeWebFunctionEndpoint",
            Resource: this.endpoint.endpointArn,
          },
        ],
      }),
    });
  }
}
