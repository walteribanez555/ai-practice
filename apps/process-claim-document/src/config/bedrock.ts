import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { createLogger } from './logger';

const logger = createLogger('Bedrock');

export const bedrockClient = new BedrockRuntimeClient({ region: 'us-east-1' });

export const BEDROCK_MODEL_ID =
  process.env.BEDROCK_MODEL_ID ?? 'us.amazon.nova-pro-v1:0';

// Set by CDK after guardrail deployment. Empty string = guardrail disabled (safe default).
export const GUARDRAIL_ID      = process.env.GUARDRAIL_ID      ?? '';
export const GUARDRAIL_VERSION = process.env.GUARDRAIL_VERSION ?? 'DRAFT';

logger.debug('Bedrock client initialized', { modelId: BEDROCK_MODEL_ID, guardrailId: GUARDRAIL_ID || 'disabled' });
