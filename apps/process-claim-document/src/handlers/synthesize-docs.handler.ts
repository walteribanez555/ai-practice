/**
 * Step Functions handler — cross-document consistency synthesis.
 *
 * Receives all per-document extraction results together and asks Bedrock
 * to compare them: detect contradictions in dates, amounts, parties, and
 * claim types across documents. This catches fraud patterns invisible
 * when analyzing each document in isolation.
 *
 * Input:  { claimId, extractions: Array<[ExtractionResult, IntegrityResult]> }
 * Output: ConsistencyResult
 */

import type { Handler }    from 'aws-lambda';
import { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { bedrockClient, BEDROCK_MODEL_ID, GUARDRAIL_ID, GUARDRAIL_VERSION } from '../config/bedrock';
import { createLogger }    from '../config/logger';
import type { SynthesizeDocsInput, ConsistencyResult, ExtractionResult } from './sf.types';

const logger = createLogger('SynthesizeDocs');

const SYSTEM_PROMPT = `You are a senior insurance fraud investigator specializing in cross-document analysis.
You receive structured data extracted from multiple claim documents and identify inconsistencies
that indicate potential fraud or honest mistakes.

Focus on:
- Date contradictions (incident date differs between documents)
- Amount discrepancies (estimate vs invoice vs report)
- Party contradictions (different names, plates, IDs for the same entity)
- Claim type conflicts (one doc says auto, another says home)
- Narrative inconsistencies (descriptions contradict each other)

Be specific: name the exact contradiction and which documents conflict.
Be conservative: only flag genuine contradictions, not mere differences in detail level.`;

export const handler: Handler<SynthesizeDocsInput, ConsistencyResult> = async (event) => {
  const { claimId, extractions } = event;

  logger.info('Synthesizing cross-document consistency', { claimId, docCount: extractions.length });

  if (extractions.length <= 1) {
    return {
      consistent:           true,
      contradictions:       [],
      crossDocObservations: 'Single document — no cross-document analysis possible.',
    };
  }

  const summaries = extractions.map(([ext], i) => {
    const e = ext as ExtractionResult;
    return [
      `Document ${i + 1} (${e.contentType}):`,
      `  Type: ${e.claimType ?? 'unknown'}`,
      `  Date: ${e.incidentDate ?? 'not found'}`,
      `  Amount: ${e.estimatedAmount != null ? `$${e.estimatedAmount}` : 'not found'}`,
      `  Parties: ${e.involvedParties?.join(', ') ?? 'none'}`,
      `  Description: ${e.descriptionSummary ?? 'none'}`,
    ].join('\n');
  }).join('\n\n');

  const userPrompt = `Analyze these ${extractions.length} claim documents for cross-document consistency:\n\n${summaries}\n\nIdentify any contradictions between the documents using the analyze_consistency tool.`;

  const tool = {
    toolSpec: {
      name: 'analyze_consistency',
      description: 'Report cross-document consistency findings for an insurance claim.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            consistent: {
              type: 'boolean',
              description: 'True if all documents are consistent with each other.',
            },
            contradictions: {
              type: 'array',
              items: { type: 'string' },
              description: 'List of specific contradictions found between documents. Empty if consistent.',
            },
            crossDocObservations: {
              type: 'string',
              description: 'Professional summary of the cross-document analysis.',
            },
          },
          required: ['consistent', 'contradictions', 'crossDocObservations'],
        },
      },
    },
  };

  const response = await bedrockClient.send(new ConverseCommand({
    modelId:  BEDROCK_MODEL_ID,
    system:   [{ text: SYSTEM_PROMPT }],
    messages: [{ role: 'user', content: [{ text: userPrompt }] }],
    toolConfig: {
      tools:      [tool],
      toolChoice: { tool: { name: 'analyze_consistency' } },
    },
    guardrailConfig: GUARDRAIL_ID
      ? { guardrailIdentifier: GUARDRAIL_ID, guardrailVersion: GUARDRAIL_VERSION, trace: 'enabled' }
      : undefined,
  }));

  const toolBlock = response.output?.message?.content?.find(b => b.toolUse?.name === 'analyze_consistency');
  if (!toolBlock?.toolUse?.input) {
    throw new Error(`Bedrock did not return analyze_consistency block (stopReason: ${response.stopReason})`);
  }

  const result = toolBlock.toolUse.input as unknown as ConsistencyResult;
  logger.info('Synthesis complete', { claimId, consistent: result.consistent, contradictions: result.contradictions.length });
  return result;
};
