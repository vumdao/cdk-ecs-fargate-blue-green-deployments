import { App } from 'aws-cdk-lib';
import { EcsBlueGreenDeploymentsPipeline } from './pipeline/pipeline';
import { devEnv } from './shared/environment';
import { TagsProp } from './shared/tagging';

const app = new App();

new EcsBlueGreenDeploymentsPipeline(app, 'simflexcloud-ecs-blue-green-deployments-pipeline', { env: devEnv, tags: TagsProp('blue-green-deployments', devEnv) });

app.synth();