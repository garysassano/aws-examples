import { join } from "node:path";
import {
  BuildSpec,
  ComputeType,
  LinuxArmBuildImage,
  Project,
  Source,
} from "aws-cdk-lib/aws-codebuild";
import { Repository } from "aws-cdk-lib/aws-ecr";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import { Asset } from "aws-cdk-lib/aws-s3-assets";
import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib/core";
import type { Construct } from "constructs";
import { IMAGE_BUILDER_PROJECT, PLAIN_TAG, RESOURCE_PREFIX, SOCI_TAG } from "../constants.js";

export class ImageStack extends Stack {
  public readonly repository: Repository;

  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    this.repository = new Repository(this, "ImageRepository", {
      repositoryName: RESOURCE_PREFIX,
      removalPolicy: RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });

    const imageSource = new Asset(this, "ImageSource", {
      path: join(import.meta.dirname, "../image"),
    });

    const imageBuilder = new Project(this, "ImageBuilder", {
      projectName: IMAGE_BUILDER_PROJECT,
      source: Source.s3({ bucket: imageSource.bucket, path: imageSource.s3ObjectKey }),
      environment: {
        buildImage: LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_4_0,
        computeType: ComputeType.LARGE,
        // Docker and containerd both need it
        privileged: true,
      },
      timeout: Duration.hours(1),
      // CodeBuild would otherwise create a log group the stack can't delete
      logging: { cloudWatch: { logGroup: new LogGroup(this, "ImageBuilderLogGroup") } },
      environmentVariables: {
        REGISTRY: { value: `${this.account}.dkr.ecr.${this.region}.amazonaws.com` },
        IMAGE: { value: this.repository.repositoryUri },
        PLAIN_TAG: { value: PLAIN_TAG },
        SOCI_TAG: { value: SOCI_TAG },
      },
      buildSpec: BuildSpec.fromObject({
        version: "0.2",
        phases: {
          install: {
            commands: [
              "dnf install -y soci-snapshotter containerd nerdctl",
              // The build container doesn't run systemd
              "nohup containerd > /tmp/containerd.log 2>&1 &",
              "sleep 5",
            ],
          },
          pre_build: {
            commands: [
              "aws ecr get-login-password | docker login --username AWS --password-stdin $REGISTRY",
              "aws ecr get-login-password | nerdctl login --username AWS --password-stdin $REGISTRY",
            ],
          },
          build: {
            commands: [
              // Lambda rejects the attestation manifests Docker adds by default
              "docker build --provenance=false --platform linux/arm64 -t $IMAGE:$PLAIN_TAG .",
              "docker push $IMAGE:$PLAIN_TAG",
              // The index is built from the containerd image store, not Docker's. It only needs the
              // compressed layers, and overlayfs can't unpack them on the build container's disk.
              "nerdctl pull --unpack=false --platform linux/arm64 $IMAGE:$PLAIN_TAG",
              "nerdctl image convert --soci --platform linux/arm64 $IMAGE:$PLAIN_TAG $IMAGE:$SOCI_TAG",
              "nerdctl push --platform linux/arm64 $IMAGE:$SOCI_TAG",
            ],
          },
        },
      }),
    });

    imageSource.grantRead(imageBuilder);
    this.repository.grantPullPush(imageBuilder);
  }
}
