import { RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { SecurityGroup, Vpc } from 'aws-cdk-lib/aws-ec2';
import { AppProtocol, AwsLogDriver, Cluster, ContainerImage, DeploymentControllerType, FargateService, FargateTaskDefinition, Protocol } from 'aws-cdk-lib/aws-ecs';
import { ApplicationLoadBalancer, ApplicationProtocol } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';
import { PROJECT_OWNER } from './shared/constants';
import { EnvironmentConfig } from './shared/environment';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { EcsApplication, EcsDeploymentConfig, EcsDeploymentGroup } from 'aws-cdk-lib/aws-codedeploy';
import { ManagedPolicy, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Repository as CodeCommitRepo } from 'aws-cdk-lib/aws-codecommit';
import { Repository } from 'aws-cdk-lib/aws-ecr';
import { BuildSpec, LinuxBuildImage, PipelineProject } from 'aws-cdk-lib/aws-codebuild';
import { Artifact, Pipeline } from 'aws-cdk-lib/aws-codepipeline';
import { CodeBuildAction, CodeCommitSourceAction, CodeDeployEcsDeployAction } from 'aws-cdk-lib/aws-codepipeline-actions';

export class EcsBlueGreenDeploymentsStack extends Stack {
  private static readonly PREFIX: string = 'ecs-fargate-blue-green-deployments';

  constructor(scope: Construct, id: string, reg: EnvironmentConfig, props?: StackProps) {
    super(scope, id, props);

    const prefix = `${reg.pattern}-${PROJECT_OWNER}-${reg.stage}-${EcsBlueGreenDeploymentsStack.PREFIX}`;

    const ecsRole = new Role(this, `${prefix}-ecs-role`, {
      roleName: `${prefix}-ecs-task`,
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')],
    });

    /**
     * Elastic Container Registry
     */
    const projectEcr = new Repository(this, `${prefix}-ecr`, {
      repositoryName: `${PROJECT_OWNER}/${EcsBlueGreenDeploymentsStack.PREFIX}`,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    /**
     * Codecommit for versioning project
     */
    const repo = new CodeCommitRepo(this, `${prefix}-repo`, {
      description: 'ECS Bule/Green deployments',
      repositoryName: EcsBlueGreenDeploymentsStack.PREFIX,
    });

    /**
     * CodeBuild role
     */
    const role = new Role(this, `${prefix}-codebuild-role`, {
      roleName: `${prefix}-codebuild`,
      assumedBy: new ServicePrincipal('codebuild.amazonaws.com'),
    });

    projectEcr.grantPullPush(role);

    /**
     * Pipeline build docker image
     */
    const souceOutput = new Artifact('sourceArtifact');
    const buidspecOutput = new Artifact('buildArtifact');

    const pipelineProject = new PipelineProject(this, `${prefix}-codebuild`, {
      projectName: `${prefix}-codebuild`,
      description: 'Pipeline for building docker image',
      buildSpec: BuildSpec.fromSourceFilename('./buildspec.yml'),
      environment: {
        privileged: true,
        buildImage: LinuxBuildImage.STANDARD_7_0,
      },
      environmentVariables: {
        IMAGE_REPO_NAME: { value: projectEcr.repositoryName },
        REPOSITORY_URI: { value: projectEcr.repositoryUri },
        IMAGE_TAG: { value: 'latest' },
        AWS_ACCOUNT_ID: { value: reg.account },
        AWS_REGION: { value: reg.region },
        TASK_EXECUTION_ARN: { value: ecsRole.roleArn }
      },
      role: role,
    });


    const buildImagePipeline = new Pipeline(this, `${prefix}-build-image`, {
      pipelineName: `master-${prefix}`,
    });

    buildImagePipeline.addStage({
      stageName: 'Source',
      actions: [
        new CodeCommitSourceAction({
          actionName: 'CodeCommit',
          repository: repo,
          output: souceOutput,
          branch: 'master',
        }),
      ],
    });

    buildImagePipeline.addStage({
      stageName: 'Build',
      actions: [new CodeBuildAction({
        actionName: 'CodeBuild',
        project: pipelineProject,
        input: souceOutput,
        outputs: [buidspecOutput],
      })],
    });

    const vpc = new Vpc(this, `${prefix}-vpc`, {
      vpcName: prefix,
      natGateways: 1,
      maxAzs: 2,
    });

    const alb = new ApplicationLoadBalancer(this, `${prefix}-alb`, {
      loadBalancerName: 'ecs-fargate-blue-green',
      vpc: vpc,
      internetFacing: true,
    });

    const ecs = new Cluster(this, `${prefix}-cluster`, {
      clusterName: prefix,
      vpc: vpc,
    });

    /**
     * Create task definition.
     */
    const taskDefinition = new FargateTaskDefinition(this, `${prefix}-fargate-task-definition`, {
      executionRole: ecsRole,
      taskRole: ecsRole,
      cpu: 256,
      memoryLimitMiB: 512,
    });
    taskDefinition.addContainer(`${prefix}-container`, {
      image: ContainerImage.fromEcrRepository(projectEcr, 'latest'),
      portMappings: [
        { containerPort: 8080, protocol: Protocol.TCP, name: 'ecs-container-8080-tcp', appProtocol: AppProtocol.http },
      ],
      memoryLimitMiB: 512,
      logging: new AwsLogDriver({
        logGroup: new LogGroup(this, `${prefix}-fargate-task-definition-log-group`, {
          logGroupName: `/ecs/${prefix}-fargate-task-definition-log-group`,
          removalPolicy: RemovalPolicy.DESTROY
        }),
        streamPrefix: EcsBlueGreenDeploymentsStack.PREFIX
      })
    });

    const fargateSg = new SecurityGroup(this, `${prefix}-fargate-sg`, {
      securityGroupName: `${prefix}-fargate`,
      vpc: vpc,
    });

    /**
     * Create two services, one for your prod application and one for test application.
     */
    const service = new FargateService(this, `${prefix}-fargate-service`, {
      serviceName: `${prefix}-fargate-svc`,
      taskDefinition: taskDefinition,
      desiredCount: 3,
      cluster: ecs,
      securityGroups: [fargateSg],
      deploymentController: {
        type: DeploymentControllerType.CODE_DEPLOY
      },
      capacityProviderStrategies: [
        {capacityProvider: 'FARGATE_SPOT'}
      ]
    });

    //const scaleTask = service.autoScaleTaskCount({minCapacity: 3, maxCapacity: 10})

    /**
     * Create blue/green target groups.
     * Listener rule port 80 for prod application and 8080 for test application.
     */
    const prodListener = alb.addListener(`${prefix}-prod-listener`, { port: 80, open: true });
    const blueTG = prodListener.addTargets(`${prefix}-blue-target-group`, {
      targetGroupName: `simflexcloud-blue-target-group`,
      protocol: ApplicationProtocol.HTTP,
      healthCheck: { path: '/' },
      targets: [service],
    });

    const testListener = alb.addListener(`${prefix}-test-listener`, { port: 8080, open: true });
    const greenTG = testListener.addTargets(`${prefix}-target-8080`, {
      targetGroupName: `simflexcloud-green-target-group`,
      protocol: ApplicationProtocol.HTTP,
      healthCheck: { path: '/' },
      targets: [service],
    });

    /**
     * ECS Blue/Green Deployment Group
     */
    const ecsDeploymentGp = new EcsDeploymentGroup(this, `${prefix}-ecs-deployment-group`, {
      deploymentGroupName: prefix,
      deploymentConfig: EcsDeploymentConfig.LINEAR_10PERCENT_EVERY_1MINUTES,
      application: new EcsApplication(this, `${prefix}-ecs-application`, {applicationName: prefix}),
      service: service,
      blueGreenDeploymentConfig: {
        blueTargetGroup: blueTG,
        greenTargetGroup: greenTG,
        listener: prodListener,
        testListener: testListener,
      },
    });

    /**
     * Set this to `false` at the first deploy to remove the cyclic dependency.
     *  - Build image pipeline depends on ECS stack to create CodeDeploy ECS deployment group.
     *  - ECS service depends on build image pipeline stack to have the ECR image to run tasks.
     * Set this to `true` and run `cdk deploy` again.
     */
    if (false) {
      buildImagePipeline.addStage({
        stageName: 'Deploy',
        actions: [
          new CodeDeployEcsDeployAction({
            actionName: 'Deploy',
            deploymentGroup: ecsDeploymentGp,
            appSpecTemplateInput: buidspecOutput,
            taskDefinitionTemplateInput: buidspecOutput,
          })
        ]
      })
    }
  }
}