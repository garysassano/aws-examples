import { Construct } from "constructs";
import { EcrRepository } from "../../.gen/providers/aws/ecr-repository/index.js";
import { LambdaFunction } from "../../.gen/providers/aws/lambda-function/index.js";
import { LambdaFunctionUrl } from "../../.gen/providers/aws/lambda-function-url/index.js";
import { Image } from "../../.gen/providers/docker/image/index.js";
import { RegistryImage } from "../../.gen/providers/docker/registry-image/index.js";
import { hashBuildContext } from "../utils/hash-context.js";

export interface LambdaWebAppProps {
  /** Prefix for the ECR repository (`<name>-repo`) and the function (`<name>-lambda`). */
  readonly name: string;
  /** Directory holding the Dockerfile and its build context. */
  readonly buildContext: string;
  /** ARN of the function's execution role. */
  readonly roleArn: string;
  readonly environment?: Record<string, string>;
}

/**
 * A web server image, run on Lambda through the Lambda Web Adapter and exposed
 * over a public function URL.
 */
export class LambdaWebApp extends Construct {
  readonly function: LambdaFunction;
  readonly functionUrl: LambdaFunctionUrl;

  constructor(scope: Construct, id: string, props: LambdaWebAppProps) {
    super(scope, id);

    const repo = new EcrRepository(this, "Repo", {
      name: `${props.name}-repo`,
      // ECR refuses to delete a repository that still holds images.
      forceDelete: true,
    });

    // Rebuilds and pushes the image whenever a file in the build context changes.
    const triggers = { filesha256: hashBuildContext(props.buildContext) };

    const image = new Image(this, "Image", {
      name: repo.repositoryUrl,
      buildAttribute: {
        context: props.buildContext,
        platform: "linux/arm64",
        // Attestations make an OCI manifest list, which Lambda rejects.
        provenance: "false",
        sbom: "false",
      },
      triggers,
    });

    const pushed = new RegistryImage(this, "Push", { name: image.name, triggers });

    this.function = new LambdaFunction(this, "Function", {
      functionName: `${props.name}-lambda`,
      role: props.roleArn,
      packageType: "Image",
      // Pinning the digest makes every push update the function.
      imageUri: `${pushed.name}@${pushed.sha256Digest}`,
      architectures: ["arm64"],
      memorySize: 1769,
      timeout: 10,
      loggingConfig: { logFormat: "JSON" },
      environment: props.environment ? { variables: props.environment } : undefined,
    });

    this.functionUrl = new LambdaFunctionUrl(this, "Url", {
      functionName: this.function.functionName,
      authorizationType: "NONE",
    });
  }
}
