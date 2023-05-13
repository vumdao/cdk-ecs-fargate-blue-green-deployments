import { awscdk } from 'projen';
const project = new awscdk.AwsCdkTypeScriptApp({
  cdkVersion: '2.78.0',
  defaultReleaseBranch: 'main',
  name: 'ecs-fargate-blue-green-deployments',
  projenrcTs: true,
});
project.synth();