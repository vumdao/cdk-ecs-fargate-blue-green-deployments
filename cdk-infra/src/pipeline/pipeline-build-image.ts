import { RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { PipelineProject, BuildSpec, LinuxBuildImage } from 'aws-cdk-lib/aws-codebuild';
import { Repository as CodeCommitRepo } from 'aws-cdk-lib/aws-codecommit';
import { Artifact, Pipeline } from 'aws-cdk-lib/aws-codepipeline';
import { CodeBuildAction, CodeCommitSourceAction } from 'aws-cdk-lib/aws-codepipeline-actions';
import { Repository } from 'aws-cdk-lib/aws-ecr';
import { ManagedPolicy, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { PROJECT_OWNER } from '../shared/constants';
import { EnvironmentConfig } from '../shared/environment';

export class EcsBlueGreenBuildImage extends Stack {
  private static readonly PREFIX: string = 'ecs-fargate-blue-green-deployments';
  public buildImagePipeline: Pipeline;
  public souceOutput: Artifact;
  public projectEcr: Repository;
  public ecsRole: Role;
  constructor(
    scope: Construct,
    id: string,
    reg: EnvironmentConfig,
    props: StackProps,
  ) {
    super(scope, id, props);

    const prefix = `${reg.pattern}-${PROJECT_OWNER}-${reg.stage}-${EcsBlueGreenBuildImage.PREFIX}`;

    this.ecsRole = new Role(this, `${prefix}-ecs-role`, {
      roleName: `${prefix}-ecs-task`,
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')],
    });

    /**
     * Elastic Container Registry
     */
    this.projectEcr = new Repository(this, `${prefix}-ecr`, {
      repositoryName: `${PROJECT_OWNER}/${EcsBlueGreenBuildImage.PREFIX}`,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    /**
     * Codecommit for versioning project
     */
    const repo = new CodeCommitRepo(this, `${prefix}-repo`, {
      description: 'ECS Bule/Green deployments',
      repositoryName: EcsBlueGreenBuildImage.PREFIX,
    });

    /**
     * CodeBuild role
     */
    const role = new Role(this, `${prefix}-codebuild-role`, {
      roleName: `${prefix}-codebuild`,
      assumedBy: new ServicePrincipal('codebuild.amazonaws.com'),
    });

    this.projectEcr.grantPullPush(role);

    /**
     * Pipeline build docker image
     */
    this.souceOutput = new Artifact();

    const pipelineProject = new PipelineProject(this, `${prefix}-codebuild`, {
      projectName: `${prefix}-codebuild`,
      description: 'Pipeline for building docker image',
      buildSpec: BuildSpec.fromSourceFilename('./buildspec.yml'),
      environment: {
        privileged: true,
        buildImage: LinuxBuildImage.STANDARD_7_0,
      },
      environmentVariables: {
        IMAGE_REPO_NAME: { value: this.projectEcr.repositoryName },
        REPOSITORY_URI: { value: this.projectEcr.repositoryUri },
        IMAGE_TAG: { value: 'latest' },
        AWS_ACCOUNT_ID: { value: reg.account },
        AWS_REGION: { value: reg.region },
        TASK_EXECUTION_ARN: { value: this.ecsRole.roleArn }
      },
      role: role,
    });


    this.buildImagePipeline = new Pipeline(this, `${prefix}-build-image`, {
      pipelineName: `master-${prefix}`,
    });

    this.buildImagePipeline.addStage({
      stageName: 'Source',
      actions: [
        new CodeCommitSourceAction({
          actionName: 'CodeCommit',
          repository: repo,
          output: this.souceOutput,
          branch: 'master',
        }),
      ],
    });

    this.buildImagePipeline.addStage({
      stageName: 'Build',
      actions: [new CodeBuildAction({
        actionName: 'CodeBuild',
        project: pipelineProject,
        input: this.souceOutput,
      })],
    });
  }
}
