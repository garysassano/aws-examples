import { SecurityGroup, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import {
  Cluster,
  Compatibility,
  ContainerImage,
  CpuArchitecture,
  FargateService,
  LogDrivers,
  ManagedInstancesCapacityProvider,
  NetworkMode,
  OperatingSystemFamily,
  TaskDefinition,
} from "aws-cdk-lib/aws-ecs";
import { Size, Stack, type StackProps } from "aws-cdk-lib/core";
import type { Construct } from "constructs";

export class MyStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    const defaultVpc = Vpc.fromLookup(this, "DefaultVpc", { isDefault: true });

    const defaultSg = new SecurityGroup(this, "DefaultSg", {
      vpc: defaultVpc,
    });

    const emiCluster = new Cluster(this, "EMICluster", {
      clusterName: "emi-cluster",
      vpc: defaultVpc,
    });

    const emiCapacityProvider = new ManagedInstancesCapacityProvider(this, "EMICapacityProvider", {
      capacityProviderName: "emi-capacity-provider",
      subnets: defaultVpc.selectSubnets({ subnetType: SubnetType.PUBLIC }).subnets,
      securityGroups: [defaultSg],
      instanceRequirements: {
        vCpuCountMin: 1,
        memoryMin: Size.gibibytes(2),
        allowedInstanceTypes: ["c9g.xlarge"],
      },
    });

    emiCluster.addManagedInstancesCapacityProvider(emiCapacityProvider);

    const emiTaskDefinition = new TaskDefinition(this, "EMITaskDefinition", {
      compatibility: Compatibility.MANAGED_INSTANCES,
      cpu: "1024",
      memoryMiB: "2048",
      networkMode: NetworkMode.AWS_VPC,
      runtimePlatform: {
        cpuArchitecture: CpuArchitecture.ARM64,
        operatingSystemFamily: OperatingSystemFamily.LINUX,
      },
    });

    emiTaskDefinition.addContainer("web", {
      image: ContainerImage.fromRegistry("public.ecr.aws/docker/library/nginx:stable"),
      portMappings: [{ containerPort: 80 }],
      healthCheck: {
        command: ["CMD-SHELL", "curl -fs http://localhost/ > /dev/null"],
      },
      logging: LogDrivers.awsLogs({ streamPrefix: "web" }),
    });

    new FargateService(this, "EMIService", {
      serviceName: "emi-service",
      cluster: emiCluster,
      taskDefinition: emiTaskDefinition,
      desiredCount: 2,
      minHealthyPercent: 100,
      circuitBreaker: { rollback: true },
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
      capacityProviderStrategies: [
        {
          capacityProvider: emiCapacityProvider.capacityProviderName,
          weight: 1,
        },
      ],
    });
  }
}
