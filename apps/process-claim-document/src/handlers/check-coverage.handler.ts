/**
 * Step Functions handler — check policy coverage via Bedrock Knowledge Base.
 *
 * Now runs in Phase 2, AFTER extraction, so it has the real claim description
 * and claim type to build a meaningful RAG query.
 *
 * Input:  { claimId, extractions, claimContext? }
 * Output: CoverageResult
 */

import {
  BedrockAgentRuntimeClient,
  RetrieveCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { createLogger } from '../config/logger';
import type { CheckCoverageInput, CoverageResult, ExtractionResult } from './sf.types';
import type { Handler } from 'aws-lambda';

const logger   = createLogger('CheckCoverage');
const kbClient = new BedrockAgentRuntimeClient({ region: 'us-east-1' });

const KB_ID         = process.env.KNOWLEDGE_BASE_ID ?? '';
const SCORE_COVERED = 0.78;
const SCORE_REVIEW  = 0.52;
const RESULTS_N     = 4;

function buildQuery(input: CheckCoverageInput): string {
  const extractions = input.extractions ?? [];

  // Gather all descriptions and claim types across documents
  const descriptions = extractions
    .map(([ext]) => (ext as ExtractionResult).descriptionSummary)
    .filter(Boolean)
    .join('. ');

  const types = [...new Set(
    extractions.map(([ext]) => (ext as ExtractionResult).claimType).filter(Boolean)
  )].join(', ');

  const parts: string[] = [];
  if (types)        parts.push(`Tipo de siniestro: ${types}`);
  if (descriptions) parts.push(descriptions);
  if (input.claimContext) parts.push(input.claimContext);
  parts.push('cobertura incluida clausula aplicable exclusiones deducible');

  return parts.join('. ');
}

function extractClauseRef(text: string): string {
  const match = text.match(/[Ss]eccion\s+[\d.]+[^.\n]*/);
  return match ? match[0].trim().substring(0, 300) : text.substring(0, 300);
}

export const handler: Handler<CheckCoverageInput, CoverageResult> = async (event) => {
  const { claimId } = event;

  if (!KB_ID) {
    logger.warn('KNOWLEDGE_BASE_ID not set — returning requires_review', { claimId });
    return { coverageApplies: 'requires_review', referenceClause: null };
  }

  const query = buildQuery(event);
  logger.info('Querying knowledge base', { claimId, queryLength: query.length });

  const response = await kbClient.send(new RetrieveCommand({
    knowledgeBaseId: KB_ID,
    retrievalQuery:  { text: query },
    retrievalConfiguration: { vectorSearchConfiguration: { numberOfResults: RESULTS_N } },
  }));

  const results = response.retrievalResults ?? [];
  const topScore = results[0]?.score ?? 0;

  logger.info('KB results', { claimId, count: results.length, topScore });

  if (!results.length || topScore < SCORE_REVIEW) {
    return { coverageApplies: 'not_covered', referenceClause: null };
  }

  const coverageApplies: CoverageResult['coverageApplies'] =
    topScore >= SCORE_COVERED ? 'covered' : 'requires_review';

  return {
    coverageApplies,
    referenceClause: extractClauseRef(results[0].content?.text ?? ''),
  };
};
