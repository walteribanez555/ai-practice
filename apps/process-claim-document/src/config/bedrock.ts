import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { createLogger } from './logger';

const logger = createLogger('Bedrock');

export const bedrockClient = new BedrockRuntimeClient({ region: 'us-east-1' });

// Amazon Nova Pro: supports images + PDFs + tool use — ~4x cheaper than Claude Sonnet.
// Override via BEDROCK_MODEL_ID env var if needed.
export const BEDROCK_MODEL_ID =
  process.env.BEDROCK_MODEL_ID ?? 'us.amazon.nova-pro-v1:0';

logger.debug('Bedrock client initialized', { modelId: BEDROCK_MODEL_ID });
