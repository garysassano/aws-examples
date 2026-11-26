import { join } from "node:path";
import {
  BuildSpec,
  ComputeType,
  LinuxBuildImage,
  Project,
  Source,
} from "aws-cdk-lib/aws-codebuild";
import { Repository } from "aws-cdk-lib/aws-ecr";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { Asset } from "aws-cdk-lib/aws-s3-assets";
import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib/core";
import type { Construct } from "constructs";
import {
  BASE_IMAGE,
  BASE_TAG,
  IMAGE_BUILDER_PROJECT,
  MODEL_ID,
  MODEL_PREFIX,
  MODEL_TAG,
  RESOURCE_PREFIX,
} from "../constants.js";

export class ImageStack extends Stack {
  public readonly repository: Repository;
  public readonly modelBucket: Bucket;

  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    this.repository = new Repository(this, "ImageRepository", {
      repositoryName: RESOURCE_PREFIX,
      removalPolicy: RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });

    this.modelBucket = new Bucket(this, "ModelBucket", {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const imageSource = new Asset(this, "ImageSource", {
      path: join(import.meta.dirname, "../image"),
    });

    const imageBuilder = new Project(this, "ImageBuilder", {
      projectName: IMAGE_BUILDER_PROJECT,
      source: Source.s3({ bucket: imageSource.bucket, path: imageSource.s3ObjectKey }),
      environment: {
        // GPU instances are x86, and so is Lambda's vLLM image
        buildImage: LinuxBuildImage.AMAZON_LINUX_2023_6,
        // 128 GB of disk, enough for the base image unpacked, the weights, and both image stores
        computeType: ComputeType.LARGE,
        // Docker and containerd both need it
        privileged: true,
      },
      timeout: Duration.hours(2),
      // CodeBuild would otherwise create a log group the stack can't delete
      logging: { cloudWatch: { logGroup: new LogGroup(this, "ImageBuilderLogGroup") } },
      environmentVariables: {
        REGISTRY: { value: `${this.account}.dkr.ecr.${this.region}.amazonaws.com` },
        IMAGE: { value: this.repository.repositoryUri },
        BASE_IMAGE: { value: BASE_IMAGE },
        BASE_TAG: { value: BASE_TAG },
        MODEL_TAG: { value: MODEL_TAG },
        MODEL_ID: { value: MODEL_ID },
        MODEL_URI: { value: this.modelBucket.s3UrlForObject(MODEL_PREFIX) },
      },
      buildSpec: BuildSpec.fromObject({
        version: "0.2",
        phases: {
          install: {
            commands: [
              "dnf install -y soci-snapshotter containerd nerdctl",
              // The build container doesn't run systemd
              "nohup containerd > /tmp/containerd.log 2>&1 &",
              "pip3 install --quiet huggingface_hub hf_xet",
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
              // The weights, for the S3 bucket and the model tag
              "hf download $MODEL_ID --local-dir model",
              "aws s3 sync model/ $MODEL_URI --exclude '.cache/*'",
              // Lambda rejects the attestation manifests Docker adds by default
              "docker build --provenance=false --build-arg BASE_IMAGE=$BASE_IMAGE -t $IMAGE:$MODEL_TAG-plain .",
              "docker push $IMAGE:$MODEL_TAG-plain",
              // Free the disk for containerd, which keeps its own copy of the layers
              "rm -rf model && docker system prune --all --force && docker builder prune --all --force",
              // The base image's SOCI index doesn't come with a copy, so both tags get their own.
              // Indexing only needs the compressed layers, which overlayfs can't unpack here anyway.
              "nerdctl pull --unpack=false $BASE_IMAGE",
              "nerdctl image convert --soci $BASE_IMAGE $IMAGE:$BASE_TAG",
              "nerdctl push $IMAGE:$BASE_TAG",
              "nerdctl pull --unpack=false $IMAGE:$MODEL_TAG-plain",
              "nerdctl image convert --soci $IMAGE:$MODEL_TAG-plain $IMAGE:$MODEL_TAG",
              "nerdctl push $IMAGE:$MODEL_TAG",
            ],
          },
        },
      }),
    });

    imageSource.grantRead(imageBuilder);
    this.repository.grantPullPush(imageBuilder);
    this.modelBucket.grantReadWrite(imageBuilder);
  }
}
