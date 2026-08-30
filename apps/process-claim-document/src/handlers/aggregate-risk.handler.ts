/**
 * Step Functions handler — aggregate all parallel analysis results.
 *
 * Input:  AggregateRiskEvent (full state after Parallel)
 *   analysisResults[0] → per-document [ExtractionResult, IntegrityResult][]
 *   analysisResults[1] → HistoryResult
 *   analysisResults[2] → CoverageResult
 *
 * Output: updates the claim in DynamoDB with:
 *   - Merged extracted fields (consensus across documents)
 *   - Composite fraud score with per-signal justification
 *   - Coverage decision
 *   - Routing priority
 */

import type { Handler } from 'aws-lambda';
import { ClaimEntity } from '../orm/entities/claim.entity';
import { createLogger } from '../config/logger';
import type { AggregateRiskEvent, ExtractionResult, IntegrityResult } from './sf.types';

const logger = createLogger('AggregateRisk');

const FRAUD_THRESHOLD      = 60;
const HIGH_AMOUNT_THRESHOLD = 50_000;

// ── Merge extractions ─────────────────────────────────────────────────────────

function mergeExtractions(extractions: ExtractionResult[]) {
  const claimType         = extractions.find((e) => e.claimType)?.claimType         ?? null;
  const estimatedAmount   = Math.max(...extractions.map((e) => e.estimatedAmount ?? 0)) || null;
  const incidentDate      = extractions.find((e) => e.incidentDate)?.incidentDate      ?? null;
  const descriptionSummary = extractions.find((e) => e.descriptionSummary)?.descriptionSummary ?? null;
  const involvedParties   = [...new Set(extractions.flatMap((e) => e.involvedParties ?? []))];

  // Inconsistency: multiple documents claim different types
  const claimTypes = new Set(extractions.map((e) => e.claimType).filter(Boolean));
  const crossDocInconsistent = claimTypes.size > 1;

  return { claimType, estimatedAmount, incidentDate, descriptionSummary, involvedParties, crossDocInconsistent, claimTypes };
}

// ── Fraud scoring ─────────────────────────────────────────────────────────────

function computeFraudScore(
  integrities:         IntegrityResult[],
  history:             { recentClaimCount: number; flagged: boolean },
  crossDocInconsistent: boolean,
  claimTypes:          Set<string | null>,
): { score: number; signals: string[] } {
  let score = 0;
  const signals: string[] = [];

  const anyAlteration = integrities.some((i) => i.possibleAlteration);
  const anyLowQuality  = integrities.some((i) => i.lowQualityDocument);
  const anyInconsistent = integrities.some((i) => i.inconsistentParties);
  const avgIntegrityScore = integrities.reduce((s, i) => s + i.integrityScore, 0) / integrities.length;

  if (anyAlteration) {
    score += 50;
    signals.push('Possible document alteration detected by forensic analysis.');
  }
  if (anyLowQuality) {
    score += 20;
    signals.push('Low-quality document submitted — key data may be obscured.');
  }
  if (anyInconsistent) {
    score += 20;
    signals.push('Inconsistent party information found within a document.');
  }
  if (crossDocInconsistent) {
    score += 30;
    signals.push(`Inconsistent claim types across documents: ${[...claimTypes].join(', ')}.`);
  }
  if (history.flagged) {
    score += 25;
    signals.push(`Client has ${history.recentClaimCount} recent claims in the last 30 days.`);
  }

  // Average integrity score adds a fractional contribution
  score = Math.min(Math.round(score + avgIntegrityScore * 0.15), 100);

  return { score, signals };
}

// ── Handler ───────────────────────────────────────────────────────────────────

export const handler: Handler<AggregateRiskEvent> = async (event) => {
  const { claimId, analysisResults } = event;

  // Error path: PropagateError forwards { claimId, error, cause } when a branch fails
  if (!analysisResults) {
    const { error, cause } = event as unknown as { error: string; cause: string };
    let errorReason = error;
    try { errorReason = (JSON.parse(cause) as { errorMessage?: string }).errorMessage ?? error; } catch { /* keep raw */ }
    logger.warn('Claim analysis failed — marking as error', { claimId, error });
    await ClaimEntity.update(claimId, { status: 'error', errorReason, processedAt: new Date().toISOString() });
    return;
  }

  const [perDocResults, history, coverage] = analysisResults;

  logger.info('Aggregating risk', { claimId, documentCount: perDocResults.length });

  const extractions  = perDocResults.map(([ext]) => ext);
  const integrities  = perDocResults.map(([, int]) => int);

  const {
    claimType, estimatedAmount, incidentDate,
    descriptionSummary, involvedParties,
    crossDocInconsistent, claimTypes,
  } = mergeExtractions(extractions);

  const { score: fraudScore, signals } = computeFraudScore(
    integrities, history, crossDocInconsistent, claimTypes,
  );

  const requiresHumanReview = fraudScore >= FRAUD_THRESHOLD;
  const priority = (
    requiresHumanReview || (estimatedAmount !== null && estimatedAmount > HIGH_AMOUNT_THRESHOLD)
      ? 'high'
      : fraudScore >= 30
      ? 'medium'
      : 'low'
  ) as 'high' | 'medium' | 'low';

  logger.info('Risk aggregated', { claimId, fraudScore, requiresHumanReview, priority });

  await ClaimEntity.update(claimId, {
    status:              'processed',
    claimType:           claimType           ?? undefined,
    estimatedAmount:     estimatedAmount      ?? undefined,
    incidentDate:        incidentDate         ?? undefined,
    involvedParties:     involvedParties.length ? involvedParties : undefined,
    descriptionSummary:  descriptionSummary   ?? undefined,
    fraudRiskScore:      fraudScore,
    riskJustification:   signals.join(' | ') || undefined,
    coverageApplies:     coverage.coverageApplies,
    requiresHumanReview,
    priority,
    processedAt:         new Date().toISOString(),
  });
};
