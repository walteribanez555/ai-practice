/**
 * Step Functions handler — extract structured data from ONE document.
 *
 * Input:  { claimId, document: { key, contentType } }
 * Output: ExtractionResult — structured claim fields (claimType, amount, date, parties, summary)
 */

import type { Handler } from 'aws-lambda';
import { BedrockService } from '../common/services/bedrock.service';
import { createLogger } from '../config/logger';
import type { AnalyzeDocumentInput, ExtractionResult } from './sf.types';

const logger = createLogger('ExtractData');

export const handler: Handler<AnalyzeDocumentInput, ExtractionResult> = async (event) => {
  const { claimId, document } = event;
  logger.info('Extracting data', { claimId, documentKey: document.key });

  const { extracted } = await BedrockService.extractFromDocument(document.key, document.contentType);

  return {
    documentKey:        document.key,
    claimType:          extracted.claimType,
    estimatedAmount:    extracted.estimatedAmount,
    incidentDate:       extracted.incidentDate,
    involvedParties:    extracted.involvedParties,
    descriptionSummary: extracted.descriptionSummary,
  };
};
