/**
 * Step Functions handler — check policy coverage via Bedrock Knowledge Base.
 *
 * Input:  { claimId, policyId? }
 * Output: CoverageResult — whether the claim type is covered and the relevant clause
 *
 * Stub: returns requires_review until the Knowledge Base is provisioned.
 * Replace the body with a BedrockAgentRuntime.retrieve() call against the
 * policies Knowledge Base (OpenSearch Serverless) in the next iteration.
 */

import type { Handler } from 'aws-lambda';
import { createLogger } from '../config/logger';
import type { CheckCoverageInput, CoverageResult } from './sf.types';

const logger = createLogger('CheckCoverage');

export const handler: Handler<CheckCoverageInput, CoverageResult> = async (event) => {
  const { claimId } = event;
  logger.info('Checking policy coverage', { claimId });

  // TODO: replace with BedrockAgentRuntime.retrieve() against the policies KB
  return {
    coverageApplies: 'requires_review',
    referenceClause: null,
  };
};
