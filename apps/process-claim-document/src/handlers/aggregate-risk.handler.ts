/**
 * Step Functions handler — aggregate all phase results.
 *
 * Input:  AggregateRiskEvent
 *   phase1Results[0] → per-document [ExtractionResult, IntegrityResult][]
 *   phase1Results[1] → HistoryResult
 *   phase2Results[0] → ConsistencyResult (cross-document synthesis)
 *   phase2Results[1] → CoverageResult
 */

import type { Handler } from 'aws-lambda';
import { ClaimEntity } from '../orm/entities/claim.entity';
import type { DocumentAnalysis } from '../orm/entities/claim.entity';
import { createLogger } from '../config/logger';
import type { AggregateRiskEvent, ExtractionResult, IntegrityResult } from './sf.types';

const logger = createLogger('AggregateRisk');

const FRAUD_THRESHOLD       = 60;
const HIGH_AMOUNT_THRESHOLD = 50_000;

function mergeExtractions(extractions: ExtractionResult[]) {
  const claimType          = extractions.find(e => e.claimType)?.claimType ?? null;
  const estimatedAmount    = Math.max(...extractions.map(e => e.estimatedAmount ?? 0)) || null;
  const incidentDate       = extractions.find(e => e.incidentDate)?.incidentDate ?? null;
  const descriptionSummary = extractions.find(e => e.descriptionSummary)?.descriptionSummary ?? null;
  const involvedParties    = [...new Set(extractions.flatMap(e => e.involvedParties ?? []))];
  const claimTypes         = new Set(extractions.map(e => e.claimType).filter(Boolean));
  return { claimType, estimatedAmount, incidentDate, descriptionSummary, involvedParties, claimTypes };
}

function computeFraudScore(
  integrities:     IntegrityResult[],
  history:         { recentClaimCount: number; flagged: boolean },
  contradictions:  string[],
  claimTypes:      Set<string | null>,
): { score: number; signals: string[] } {
  let score = 0;
  const signals: string[] = [];

  const avgIntegrityScore = integrities.reduce((s, i) => s + i.integrityScore, 0) / integrities.length;

  if (integrities.some(i => i.possibleAlteration)) {
    score += 50;
    signals.push('Possible document alteration detected by forensic analysis.');
  }
  if (integrities.some(i => i.lowQualityDocument)) {
    score += 15;
    signals.push('Low-quality document submitted — key data may be obscured.');
  }
  if (integrities.some(i => i.inconsistentParties)) {
    score += 20;
    signals.push('Inconsistent party information within a document.');
  }
  if (claimTypes.size > 1) {
    score += 25;
    signals.push(`Conflicting claim types across documents: ${[...claimTypes].join(', ')}.`);
  }
  if (contradictions.length > 0) {
    score += Math.min(contradictions.length * 15, 30);
    signals.push(`Cross-document contradictions detected: ${contradictions.join(' | ')}`);
  }
  if (history.flagged) {
    score += 25;
    signals.push(`Client has ${history.recentClaimCount} recent claims in the last 30 days.`);
  }

  return { score: Math.min(Math.round(score + avgIntegrityScore * 0.15), 100), signals };
}

export const handler: Handler<AggregateRiskEvent> = async (event) => {
  const { claimId, phase1Results, phase2Results } = event;

  // Error path
  if (!phase1Results) {
    const { error, cause } = event as unknown as { error: string; cause: string };
    let errorReason = error;
    try { errorReason = (JSON.parse(cause) as { errorMessage?: string }).errorMessage ?? error; } catch { /* raw */ }
    logger.warn('Claim analysis failed', { claimId, error });
    await ClaimEntity.update(claimId, { status: 'error', errorReason, processedAt: new Date().toISOString() });
    return;
  }

  const [perDocResults, history] = phase1Results;
  const [consistency, coverage]  = phase2Results;

  logger.info('Aggregating risk', { claimId, docs: perDocResults.length });

  const extractions = perDocResults.map(([ext]) => ext);
  const integrities = perDocResults.map(([, int]) => int);

  const { claimType, estimatedAmount, incidentDate, descriptionSummary, involvedParties, claimTypes } =
    mergeExtractions(extractions);

  const { score: fraudScore, signals } = computeFraudScore(
    integrities, history, consistency?.contradictions ?? [], claimTypes,
  );

  const requiresHumanReview = fraudScore >= FRAUD_THRESHOLD;
  const priority = (
    requiresHumanReview || (estimatedAmount !== null && estimatedAmount > HIGH_AMOUNT_THRESHOLD)
      ? 'high' : fraudScore >= 30 ? 'medium' : 'low'
  ) as 'high' | 'medium' | 'low';

  logger.info('Risk aggregated', { claimId, fraudScore, consistent: consistency?.consistent });

  const documentAnalyses: DocumentAnalysis[] = perDocResults.map(([ext, int]) => ({
    documentKey:         ext.documentKey,
    contentType:         ext.contentType,
    claimType:           ext.claimType,
    estimatedAmount:     ext.estimatedAmount,
    incidentDate:        ext.incidentDate,
    involvedParties:     ext.involvedParties,
    descriptionSummary:  ext.descriptionSummary,
    lowQualityDocument:  int.lowQualityDocument,
    possibleAlteration:  int.possibleAlteration,
    inconsistentParties: int.inconsistentParties,
    observations:        int.observations,
    integrityScore:      int.integrityScore,
  }));

  await ClaimEntity.update(claimId, {
    status:              'processed',
    claimType:           claimType ?? undefined,
    estimatedAmount:     estimatedAmount ?? undefined,
    incidentDate:        incidentDate ?? undefined,
    involvedParties:     involvedParties.length ? involvedParties : undefined,
    descriptionSummary:  descriptionSummary ?? undefined,
    fraudRiskScore:      fraudScore,
    riskJustification:   signals.join(' | ') || undefined,
    coverageApplies:     coverage.coverageApplies,
    coverageClause:      coverage.referenceClause ?? undefined,
    crossDocConsistent:  consistency?.consistent ?? true,
    crossDocObservations: consistency?.crossDocObservations,
    requiresHumanReview,
    priority,
    processedAt:         new Date().toISOString(),
    documentAnalyses,
  });
};
