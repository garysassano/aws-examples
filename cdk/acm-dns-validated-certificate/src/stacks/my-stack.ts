import path from "node:path";
import { DnsValidatedCertificateV2 } from "@open-constructs/aws-cdk/aws-certificatemanager";
import { Distribution, HttpVersion, ViewerProtocolPolicy } from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { ARecord, AaaaRecord, HostedZone, RecordTarget } from "aws-cdk-lib/aws-route53";
import { CloudFrontTarget } from "aws-cdk-lib/aws-route53-targets";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import { CfnOutput, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib/core";
import type { Construct } from "constructs";

export interface MyStackProps extends StackProps {
  /** Domain the site is served on, such as `www.example.com`. */
  readonly domainName: string;
  /** Public Route 53 hosted zone that holds `domainName`, such as `example.com`. */
  readonly hostedZoneName: string;
}

export class MyStack extends Stack {
  constructor(scope: Construct, id: string, props: MyStackProps) {
    super(scope, id, props);

    const { domainName, hostedZoneName } = props;

    const hostedZone = HostedZone.fromLookup(this, "HostedZone", { domainName: hostedZoneName });

    // CloudFront only accepts certificates from us-east-1. This stack is elsewhere, so the construct
    // creates a `<stack>-certificates-us-east-1` stack for the native ACM certificate, validates it
    // with a CNAME in the hosted zone, and reads its ARN back through `Fn::GetStackOutput`. No
    // custom resource or Lambda function is involved.
    const certificate = new DnsValidatedCertificateV2(this, "Certificate", {
      domainName,
      hostedZone,
      certificateRegion: "us-east-1",
    });

    const bucket = new Bucket(this, "Bucket", {
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const distribution = new Distribution(this, "Distribution", {
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      defaultRootObject: "index.html",
      domainNames: [domainName],
      certificate,
      httpVersion: HttpVersion.HTTP2_AND_3,
    });

    new BucketDeployment(this, "Website", {
      sources: [Source.asset(path.join(import.meta.dirname, "../website"))],
      destinationBucket: bucket,
      distribution,
    });

    const target = RecordTarget.fromAlias(new CloudFrontTarget(distribution));
    new ARecord(this, "AliasRecord", { zone: hostedZone, recordName: domainName, target });
    new AaaaRecord(this, "AliasRecordIpv6", { zone: hostedZone, recordName: domainName, target });

    new CfnOutput(this, "Url", { value: `https://${domainName}` });
    new CfnOutput(this, "CertificateArn", { value: certificate.certificateArn });
  }
}
