import { CpuManufacturer, SecurityGroup, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import {
  CapacityOptionType,
  Cluster,
  Compatibility,
  ContainerImage,
  FargateService,
  ManagedInstancesCapacityProvider,
  NetworkMode,
  PropagateManagedInstancesTags,
  Protocol,
  TaskDefinition,
} from "aws-cdk-lib/aws-ecs";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import type { StackProps } from "aws-cdk-lib/core";
import { Size, Stack } from "aws-cdk-lib/core";
import type { Construct } from "constructs";

export class MyStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    //==============================================================================
    // VPC & SECURITY GROUP
    //==============================================================================

    const emiVpc = new Vpc(this, "EMIVpc", {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          name: "Public",
          subnetType: SubnetType.PUBLIC,
          cidrMask: 18,
        },
        {
          name: "Private",
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 18,
        },
      ],
    });

    const emiSecurityGroup = new SecurityGroup(this, "EMISecurityGroup", {
      vpc: emiVpc,
      description: "Security group for ManagedInstances capacity provider instances",
    });

    //==============================================================================
    // ECS CLUSTER & CAPACITY PROVIDER
    //==============================================================================

    const emiCluster = new Cluster(this, "EMICluster", {
      vpc: emiVpc,
    });

    const emiCapacityProvider = new ManagedInstancesCapacityProvider(this, "EMICapacityProvider", {
      capacityProviderName: "ManagedInstancesCP",
      subnets: emiVpc.privateSubnets,
      securityGroups: [emiSecurityGroup],
      capacityOptionType: CapacityOptionType.SPOT,
      propagateTags: PropagateManagedInstancesTags.CAPACITY_PROVIDER,
      instanceRequirements: {
        vCpuCountMin: 1,
        memoryMin: Size.gibibytes(2),
        cpuManufacturers: [CpuManufacturer.AMD],
        // acceleratorManufacturers: [AcceleratorManufacturer.NVIDIA],
      },
    });

    emiCluster.addManagedInstancesCapacityProvider(emiCapacityProvider);

    //==============================================================================
    // ECS TASK DEFINITIONS
    //==============================================================================

    const emiTaskRole = new Role(this, "EMITaskDefTaskRole", {
      assumedBy: new ServicePrincipal("ecs-tasks.amazonaws.com"),
    });

    // Task Definition 1 - Apache
    const emiTaskDef1 = new TaskDefinition(this, "EMITaskDef1", {
      compatibility: Compatibility.MANAGED_INSTANCES,
      cpu: "1024",
      memoryMiB: "9500",
      networkMode: NetworkMode.AWS_VPC,
      taskRole: emiTaskRole,
      family: "managedinstancescapacityproviderTaskDef1",
    });

    emiTaskDef1.addContainer("EMIWeb1", {
      image: ContainerImage.fromRegistry("public.ecr.aws/docker/library/httpd:2.4"),
      portMappings: [
        {
          containerPort: 80,
          protocol: Protocol.TCP,
        },
      ],
    });

    // Task Definition 2 - Nginx
    const emiTaskDef2 = new TaskDefinition(this, "EMITaskDef2", {
      compatibility: Compatibility.MANAGED_INSTANCES,
      cpu: "1024",
      memoryMiB: "5500",
      networkMode: NetworkMode.AWS_VPC,
      taskRole: emiTaskRole,
      family: "managedinstancescapacityproviderTaskDef2",
    });

    emiTaskDef2.addContainer("EMIWeb2", {
      image: ContainerImage.fromRegistry("public.ecr.aws/docker/library/nginx:latest"),
      portMappings: [
        {
          containerPort: 80,
          protocol: Protocol.TCP,
        },
      ],
    });

    //==============================================================================
    // ECS SERVICES
    //==============================================================================

    const emiService1 = new FargateService(this, "EMIService1", {
      cluster: emiCluster,
      taskDefinition: emiTaskDef1,
      serviceName: "ManagedInstancesService1",
      desiredCount: 2,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      capacityProviderStrategies: [
        {
          capacityProvider: emiCapacityProvider.capacityProviderName,
          weight: 1,
        },
      ],
    });

    const emiService2 = new FargateService(this, "EMIService2", {
      cluster: emiCluster,
      taskDefinition: emiTaskDef2,
      serviceName: "ManagedInstancesService2",
      desiredCount: 2,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      capacityProviderStrategies: [
        {
          capacityProvider: emiCapacityProvider.capacityProviderName,
          weight: 2,
        },
      ],
    });

    // Ensure Service 2 is created after Service 1
    emiService2.node.addDependency(emiService1);
  }
}
