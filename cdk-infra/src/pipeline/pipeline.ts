import { Stack, StackProps } from 'aws-cdk-lib';
import { Repository } from 'aws-cdk-lib/aws-codecommit';
import {
  CodeBuildStep,
  CodePipeline,
  CodePipelineSource,
} from 'aws-cdk-lib/pipelines';
import { Construct } from 'constructs';
import { EcsBlueGreenDeploymentsPipelineStage } from './pipeline-stage';
import { devEnv } from '../shared/environment';

export class EcsBlueGreenDeploymentsPipeline extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const prefix = 'ecs-fargate-blue-green-deployments-infra';

    const repository = new Repository(this, prefix, {
      description: prefix,
      repositoryName: prefix,
    });

    /**
     * Generate CDK pipeline function with input branch name
     */
    const genPipeline = function (_scope: Construct, branch: string) {
      const _pipeline = new CodePipeline(_scope, `${prefix}-${branch}`, {
        pipelineName: `${prefix}-${branch}`,
        useChangeSets: false,
        synth: new CodeBuildStep('SynthStep', {
          input: CodePipelineSource.codeCommit(repository, branch),
          installCommands: ['npm install -g aws-cdk'],
          commands: [
            'yarn install --frozen-lockfile',
            'npx projen build',
          ],
        }),
        codeBuildDefaults: {
          buildEnvironment: { privileged: true },
        },
        dockerEnabledForSynth: true,
        dockerEnabledForSelfMutation: true,
      });
      return _pipeline;
    };

    const pipeline = genPipeline(this, 'master');
    pipeline.addStage(
      new EcsBlueGreenDeploymentsPipelineStage(
        this,
        `master-${devEnv.pattern}`,
        devEnv,
        {
          env: devEnv,
        },
      ),
    );
  }
}
