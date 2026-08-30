/**
 * EventBridge scheduled handler — starts SageMaker Processing Job for fraud model retraining.
 *
 * Triggered monthly (1st of every month, 06:00 UTC) by an EventBridge Rule.
 * The Processing Job runs ml/train.py inside the managed sklearn container,
 * which: preprocesses data → trains XGBoost → deploys endpoint → updates Lambda env.
 *
 * Architecture:
 *   EventBridge Rule (cron) → this Lambda → SageMaker Processing Job → train.py
 */

import type { Handler } from 'aws-lambda';
import { SageMakerClient, CreateProcessingJobCommand } from '@aws-sdk/client-sagemaker';
import { createLogger } from '../config/logger';

const logger = createLogger('FraudRetrainTrigger');
const sm     = new SageMakerClient({});

const REGION               = process.env.AWS_DEFAULT_REGION ?? 'us-east-1';
const ML_BUCKET            = process.env.ML_BUCKET            ?? '';
const SM_EXECUTION_ROLE    = process.env.SM_EXECUTION_ROLE_ARN ?? '';
const ENDPOINT_NAME        = process.env.ENDPOINT_NAME        ?? 'fraud-scoring-serverless';
const LAMBDA_FUNCTION_NAME = process.env.LAMBDA_FUNCTION_NAME ?? '';
const MIN_AUC              = process.env.MIN_AUC              ?? '0.70';
const SKLEARN_IMAGE_URI    = process.env.SKLEARN_IMAGE_URI
  ?? `683313688378.dkr.ecr.${REGION}.amazonaws.com/sagemaker-scikit-learn:1.2-1-cpu-py3`;

export const handler: Handler = async () => {
  const jobName = `fraud-scoring-retrain-${Date.now()}`;

  logger.info('Starting fraud model retraining', { jobName, endpoint: ENDPOINT_NAME });

  await sm.send(new CreateProcessingJobCommand({
    ProcessingJobName: jobName,

    // ml.m5.large: 2 vCPU, 8 GB RAM — enough for 15k rows XGBoost
    ProcessingResources: {
      ClusterConfig: {
        InstanceType:   'ml.m5.large',
        InstanceCount:  1,
        VolumeSizeInGB: 20,
      },
    },

    AppSpecification: {
      ImageUri:            SKLEARN_IMAGE_URI,
      ContainerEntrypoint: ['python3'],
      ContainerArguments:  ['/opt/ml/processing/input/code/train.py'],
    },

    // Mount the training source code (train.py + requirements.txt) from S3
    ProcessingInputs: [{
      InputName:  'code',
      AppManaged: false,
      S3Input: {
        S3Uri:                   `s3://${ML_BUCKET}/fraud-scoring/source/`,
        LocalPath:               '/opt/ml/processing/input/code/',
        S3DataType:              'S3Prefix',
        S3InputMode:             'File',
        S3DataDistributionType:  'FullyReplicated',
        S3CompressionType:       'None',
      },
    }],

    // Config passed to train.py via environment variables
    Environment: {
      ML_BUCKET:                    ML_BUCKET,
      ENDPOINT_NAME:                ENDPOINT_NAME,
      LAMBDA_FUNCTION_NAME:         LAMBDA_FUNCTION_NAME,
      SAGEMAKER_EXECUTION_ROLE_ARN: SM_EXECUTION_ROLE,
      MIN_AUC:                      MIN_AUC,
      IS_SAGEMAKER_JOB:             'true',
    },

    RoleArn:           SM_EXECUTION_ROLE,
    StoppingCondition: { MaxRuntimeInSeconds: 3_600 },  // 1 hour hard limit
  }));

  logger.info('Processing job submitted', { jobName });
  return { jobName };
};
