/**
 * Step Functions handler — check policy coverage via Bedrock Knowledge Base.
 *
 * Queries the RAG index (OpenSearch + Titan Embeddings) to find the policy
 * clauses most relevant to the claim. Returns whether the claim type is
 * covered and the reference clause text.
 *
 * Input:  { claimId, policyId?, claimContext? }
 * Output: CoverageResult — coverageApplies + referenceClause
 */

import {
  BedrockAgentRuntimeClient,
  RetrieveCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { createLogger } from '../config/logger';
import type { CheckCoverageInput, CoverageResult } from './sf.types';
import type { Handler } from 'aws-lambda';

const logger   = createLogger('CheckCoverage');
const kbClient = new BedrockAgentRuntimeClient({ region: 'us-east-1' });

const KB_ID          = process.env.KNOWLEDGE_BASE_ID ?? '';
const SCORE_COVERED  = 0.80;   // above this → covered
const SCORE_REVIEW   = 0.55;   // between this and SCORE_COVERED → requires_review
const RESULTS_N      = 3;

function buildQuery(input: CheckCoverageInput): string {
  const parts: string[] = [];
  if (input.claimContext) parts.push(input.claimContext);
  parts.push('coberturas incluidas siniestro clausulas aplicables');
  return parts.join(' ');
}

function extractClauseRef(text: string): string {
  const match = text.match(/[Ss]eccion\s+[\d.]+[^.\n]*/);
  return match ? match[0].trim().substring(0, 200) : text.substring(0, 200);
}

export const handler: Handler<CheckCoverageInput, CoverageResult> = async (event) => {
  const { claimId } = event;

  if (!KB_ID) {
    logger.warn('KNOWLEDGE_BASE_ID not set — returning requires_review', { claimId });
    return { coverageApplies: 'requires_review', referenceClause: null };
  }

  logger.info('Querying knowledge base', { claimId, kbId: KB_ID });

  const query = buildQuery(event);

  const response = await kbClient.send(new RetrieveCommand({
    knowledgeBaseId: KB_ID,
    retrievalQuery:  { text: query },
    retrievalConfiguration: {
      vectorSearchConfiguration: { numberOfResults: RESULTS_N },
    },
  }));

  const results = response.retrievalResults ?? [];

  logger.info('KB results', {
    claimId,
    count: results.length,
    topScore: results[0]?.score ?? 0,
  });

  if (!results.length || (results[0].score ?? 0) < SCORE_REVIEW) {
    return { coverageApplies: 'not_covered', referenceClause: null };
  }

  const topResult = results[0];
  const score     = topResult.score ?? 0;
  const text      = topResult.content?.text ?? '';

  const coverageApplies: CoverageResult['coverageApplies'] =
    score >= SCORE_COVERED ? 'covered' : 'requires_review';

  return {
    coverageApplies,
    referenceClause: extractClauseRef(text),
  };
};
