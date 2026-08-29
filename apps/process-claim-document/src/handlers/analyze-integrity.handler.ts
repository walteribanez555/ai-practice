/**
 * Step Functions handler — assess document integrity for ONE document.
 *
 * Input:  { claimId, document: { key, contentType } }
 * Output: IntegrityResult — forgery/quality signals + composite integrity score (0–100)
 *
 * Score interpretation:
 *   0–20   clean document
 *   21–50  minor concerns, likely legitimate
 *   51–79  significant red flags, human review recommended
 *   80–100 high probability of manipulation
 */

import type { Handler } from 'aws-lambda';
import { BedrockService } from '../common/services/bedrock.service';
import { createLogger } from '../config/logger';
import type { AnalyzeDocumentInput, IntegrityResult } from './sf.types';

const logger = createLogger('AnalyzeIntegrity');

const SCORE_WEIGHTS = {
  possibleAlteration:  50,
  lowQualityDocument:  25,
  inconsistentParties: 25,
} as const;

export const handler: Handler<AnalyzeDocumentInput, IntegrityResult> = async (event) => {
  const { claimId, document } = event;
  logger.info('Analyzing integrity', { claimId, documentKey: document.key });

  const analysis = await BedrockService.analyzeIntegrity(document.key, document.contentType);

  const integrityScore = Math.min(
    (analysis.possibleAlteration  ? SCORE_WEIGHTS.possibleAlteration  : 0) +
    (analysis.lowQualityDocument  ? SCORE_WEIGHTS.lowQualityDocument  : 0) +
    (analysis.inconsistentParties ? SCORE_WEIGHTS.inconsistentParties : 0),
    100,
  );

  logger.info('Integrity assessed', { claimId, documentKey: document.key, integrityScore });

  return {
    documentKey:         document.key,
    lowQualityDocument:  analysis.lowQualityDocument,
    possibleAlteration:  analysis.possibleAlteration,
    inconsistentParties: analysis.inconsistentParties,
    observations:        analysis.observations,
    integrityScore,
  };
};
