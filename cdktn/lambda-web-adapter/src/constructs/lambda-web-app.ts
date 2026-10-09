import { Construct } from "constructs";
import { EcrRepository } from "../../.gen/providers/aws/ecr-repository/index.js";
import { IamRole } from "../../.gen/providers/aws/iam-role/index.js";
import { IamRolePolicy } from "../../.gen/providers/aws/iam-role-policy/index.js";
import { IamRolePolicyAttachment } from "../../.gen/providers/aws/iam-role-policy-attachment/index.js";
import { LambdaFunction } from "../../.gen/providers/aws/lambda-function/index.js";
import { LambdaFunctionUrl } from "../../.gen/providers/aws/lambda-function-url/index.js";
import { Image } from "../../.gen/providers/docker/image/index.js";
import { RegistryImage } from "../../.gen/providers/docker/registry-image/index.js";
import { hashBuildContext } from "../utils/hash-context.js";

export interface LambdaWebAppProps {
  /** Name of the ECR repository and the function, and prefix of its execution role. */
  readonly name: string;
  /** Directory holding the Dockerfile and its build context. */
  readonly buildContext: string;
  /**
   * Who may call the function URL: anyone (`NONE`), or only IAM principals that sign
   * their requests with SigV4 and are allowed to (`AWS_IAM`, see `grantInvokeUrl`).
   */
  readonly authorizationType: "NONE" | "AWS_IAM";
  readonly environment?: Record<string, string>;
}

/**
 * A web server image, run on Lambda through the Lambda Web Adapter with its own
 * execution role, and exposed over a function URL.
 */
export class LambdaWebApp extends Construct {
  readonly role: IamRole;
  readonly function: LambdaFunction;
  readonly functionUrl: LambdaFunctionUrl;

  constructor(scope: Construct, id: string, props: LambdaWebAppProps) {
    super(scope, id);

    this.role = new IamRole(this, "ExecutionRole", {
      name: `${props.name}-execution-role`,
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
    new IamRolePolicyAttachment(this, "BasicExecution", {
      role: this.role.name,
      policyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
    });

    const repository = new EcrRepository(this, "Repository", {
      name: props.name,
      // ECR refuses to delete a repository that still holds images.
      forceDelete: true,
    });

    // Rebuilds and pushes the image whenever a file in the build context changes.
    const triggers = { filesha256: hashBuildContext(props.buildContext) };

    const image = new Image(this, "Image", {
      name: repository.repositoryUrl,
      buildAttribute: {
        context: props.buildContext,
        platform: "linux/arm64",
        // Attestations make an OCI manifest list, which Lambda rejects.
        provenance: "false",
        sbom: "false",
      },
      triggers,
    });

    const pushedImage = new RegistryImage(this, "PushedImage", { name: image.name, triggers });

    this.function = new LambdaFunction(this, "Function", {
      functionName: props.name,
      role: this.role.arn,
      packageType: "Image",
      // Pinning the digest makes every push update the function.
      imageUri: `${pushedImage.name}@${pushedImage.sha256Digest}`,
      architectures: ["arm64"],
      memorySize: 1769,
      timeout: 10,
      loggingConfig: { logFormat: "JSON" },
      environment: props.environment ? { variables: props.environment } : undefined,
    });

    this.functionUrl = new LambdaFunctionUrl(this, "FunctionUrl", {
      functionName: this.function.functionName,
      authorizationType: props.authorizationType,
    });
  }

  /**
   * Lets another app's execution role call this app's `AWS_IAM` function URL. Lambda
   * requires both actions; the conditions limit them to calls through the URL.
   */
  grantInvokeUrl(caller: LambdaWebApp): void {
    new IamRolePolicy(this, `${caller.node.id}InvokeUrl`, {
      name: `invoke-${this.node.id.toLowerCase()}-url`,
      role: caller.role.name,
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: "lambda:InvokeFunctionUrl",
            Resource: this.function.arn,
            Condition: { StringEquals: { "lambda:FunctionUrlAuthType": "AWS_IAM" } },
          },
          {
            Effect: "Allow",
            Action: "lambda:InvokeFunction",
            Resource: this.function.arn,
            Condition: { Bool: { "lambda:InvokedViaFunctionUrl": "true" } },
          },
        ],
      }),
    });
  }
}
