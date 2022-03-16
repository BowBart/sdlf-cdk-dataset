import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as cdk from 'aws-cdk-lib/core';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as events from 'aws-cdk-lib/aws-events';
import * as evt from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam'
import * as glue from 'aws-cdk-lib/aws-glue'
import * as lf from 'aws-cdk-lib/aws-lakeformation'
import * as cr from 'aws-cdk-lib/custom-resources'
import datasetsJson from '../config/datasets.json';

export class SdlfCdkDatasetStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // parameters
    const pTeamName = this.node.tryGetContext('pTeamName')
    const pPipelineName = this.node.tryGetContext('pPipelineName')

    const pInfraKeyId = ssm.StringParameter.valueForStringParameter(
      this, `/SDLF/KMS/${pTeamName}/InfraKeyId`);

    const pOrg = ssm.StringParameter.valueForStringParameter(
      this, '/SDLF/Misc/pOrg');

    const pApp = ssm.StringParameter.valueForStringParameter(
      this, '/SDLF/Misc/pApp');

    const pEnvironment = ssm.StringParameter.valueForStringParameter(
      this, '/SDLF/Misc/pEnv');

    const pStageBucket = ssm.StringParameter.valueForStringParameter(
      this, '/SDLF/S3/StageBucket');

    const pCrawlerArn = ssm.StringParameter.valueForStringParameter(
      this, `/SDLF/IAM/${pTeamName}/CrawlerRoleArn` )

    const datasets = datasetsJson;

    datasets.forEach ( dataset => {
    // SQS Resources
    const rDeadLetterQueueRoutingPostStep = new sqs.Queue(this, `${dataset.name}-rDeadLetterQueueRoutingPostStep`, {
      queueName: `sdlf-${pTeamName}-${dataset.name}-dlq-b.fifo`,
      fifo: true,
      retentionPeriod: cdk.Duration.seconds(1209600),
      visibilityTimeout: cdk.Duration.seconds(60),
      encryptionMasterKey: kms.Key.fromKeyArn(this, `${dataset.name}-rDeadLetterQueueRoutingPostStepKms`, pInfraKeyId)
    });

    const rQueueRoutingPostStep = new sqs.Queue(this, `${dataset.name}-rQueueRoutingPostStep`, {
      visibilityTimeout: cdk.Duration.seconds(60),
      queueName: `sdlf-${pTeamName}-${dataset.name}-queue-b.fifo`,
      fifo: true,
      deadLetterQueue: {
        queue: rDeadLetterQueueRoutingPostStep,
        maxReceiveCount: 1
      },
      encryptionMasterKey: kms.Key.fromKeyArn(this, `${dataset.name}-rQueueRoutingPostStepKms`, pInfraKeyId)
    });

    // Triggers


    const rPostStateRule = new events.Rule (this, `${dataset.name}-rPostStateRule`, {
      ruleName: `sdlf-${pTeamName}-${dataset.name}-rule-b`,
      enabled: true,
      description: 'Trigger StageB Routing Lambda depending on the dataset Schedule Expression',
      schedule: events.Schedule.cron({ minute: "0/5" }),
      targets: [new evt.LambdaFunction(lambda.Function.fromFunctionArn(this, `${dataset.name}-rPostStateRuleTarget`, `arn:aws:lambda:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:function:sdlf-${pTeamName}-${pPipelineName}-routing-b`),
      {
        event: events.RuleTargetInput.fromObject({
          "team": pTeamName,
          "pipeline": pPipelineName,
          "pipeline_stage": "StageB",
          "dataset": dataset.name,
          "org": pOrg,
          "app": pApp,
          "env": pEnvironment
        })
      })],
    });

    const rPermissionEventsInvokeRoutingLambda = lambda.Function.fromFunctionArn(this,`${dataset.name}-rPermissionEventsInvokeRoutingLambda`, `arn:aws:lambda:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:function:sdlf-${pTeamName}-${pPipelineName}-routing-b`);

    const lamdbaInvokePermission = new lambda.CfnPermission(this, `${dataset.name}-allowInvoke`, {
      action: 'lambda:InvokeFunction',
      functionName: rPermissionEventsInvokeRoutingLambda.functionArn,
      sourceArn: rPostStateRule.ruleArn,
      principal: 'events.amazonaws.com',
    });

    // glue resource

    const rGlueDataCatalog = new glue.CfnDatabase(this, `${dataset.name}-rGlueDataCatalo`, {
      catalogId: cdk.Aws.ACCOUNT_ID,
      databaseInput: {
        name: `${pOrg}_${pApp}_${pEnvironment}_${pTeamName}_${dataset.name}_db`,
        description: `${pTeamName} team ${dataset.name} metadata catalog`
      }
    });

    const rGlueCrawler = new glue.CfnCrawler(this, `${dataset.name}-rGlueCrawler`, {
      role: pCrawlerArn,
      databaseName: rGlueDataCatalog.ref,
      name: `sdlf-${pTeamName}-${dataset.name}-post-stage-crawler`,
      targets: {
        s3Targets: [{path: `s3://${pStageBucket}/post-stage/${pTeamName}/${dataset.name}`}]
      },
    });

    const rGlueCrawlerLakeFormationPermissions = new lf.CfnPermissions(this, `${dataset.name}-rGlueCrawlerLakeFormationPermissions`, {
      dataLakePrincipal: {
        dataLakePrincipalIdentifier: pCrawlerArn,
      },
      resource: {
        databaseResource: {
          name: rGlueDataCatalog.ref
        },
      },
      permissions: [
        'CREATE_TABLE',
        'ALTER',
        'DROP',
      ]
    });

    // SSM parameters

    const rQueueRoutingPostStepSsm = new ssm.StringParameter(this, `${dataset.name}-rQueueRoutingPostStepSsm`, {
      parameterName: `/SDLF/SQS/${pTeamName}/${dataset.name}StageBQueue`,
      stringValue: rDeadLetterQueueRoutingPostStep.queueName,
      description: `Name of the StageB ${pTeamName} ${dataset.name} DLQ`
    });

    const rDeadLetterQueueRoutingPostStepSsm = new ssm.StringParameter(this, `${dataset.name}-rDeadLetterQueueRoutingPostStepSsm`, {
      parameterName: `/SDLF/SQS/${pTeamName}/${dataset.name}StageBDLQ`,
      stringValue: rDeadLetterQueueRoutingPostStep.queueName,
      description: `Name of the StageB ${pTeamName} ${dataset.name} DLQ`
    });

    const rGlueDataCatalogSsm = new ssm.StringParameter(this, `${dataset.name}-rGlueDataCatalogSsm`, {
      parameterName: `/SDLF/Glue/${pTeamName}/${dataset.name}/DataCatalog`,
      stringValue: rGlueDataCatalog.ref,
      description: `${pTeamName} team ${dataset.name} metadata catalog`
    });

    // dynamoDB

    const dataSetItem = {
      "name": {
        "S": `${pTeamName}-${dataset.name}`
      },
      "version": {
        "N": "1"
      },
      "pipeline": {
        "S": `${pPipelineName}`
      },
      "min_items_process": {
        "M": {
          "stage_c": {
            "N": "1"
          },
          "stage_b": {
            "N": "1"
          }
        }
      },
      "transforms": {
        "M": {
          "stage_a_transform": {
            "S": "light_transform_blueprint"
          },
          "stage_b_transform": {
            "S": "heavy_transform_blueprint"
          }
        }
      },
      "max_items_process": {
        "M": {
          "stage_c": {
            "N": "100"
          },
          "stage_b": {
            "N": "100"
          }
        }
      }
    }

    // Add one item to the table.
    new cr.AwsCustomResource(this, `${dataset.name}-initDBResource`, {
      onCreate: {
        service: 'DynamoDB',
        action: 'putItem',
        parameters: {
          TableName: "octagon-Datasets-dev",
          Item: dataSetItem
        },
        physicalResourceId: cr.PhysicalResourceId.of('initDBData'),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [`arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/octagon-Datasets-dev`] }),
    });

  });

  }
}
