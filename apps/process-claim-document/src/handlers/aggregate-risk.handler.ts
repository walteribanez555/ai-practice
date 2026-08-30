/**
 * Step Functions handler — aggregate all phase results.
 *
 * Input:  AggregateRiskEvent
 *   phase1Results[0] → per-document [ExtractionResult, IntegrityResult][]
 *   phase1Results[1] → HistoryResult
 *   phase2Results[0] → ConsistencyResult (cross-document synthesis)
 *   phase2Results[1] → CoverageResult
 *
 * Fraud scoring strategy:
 *   Primary  — XGBoost model via SageMaker Serverless (FRAUD_SCORING_ENDPOINT_NAME)
 *   Fallback — rule-based heuristics (always runs for explainability signals)
 */

import type { Handler } from 'aws-lambda';
import { SageMakerRuntimeClient, InvokeEndpointCommand } from '@aws-sdk/client-sagemaker-runtime';
import { S3Client, PutObjectTaggingCommand } from '@aws-sdk/client-s3';
import { ClaimEntity } from '../orm/entities/claim.entity';
import type { DocumentAnalysis } from '../orm/entities/claim.entity';
import { createLogger } from '../config/logger';
import type { AggregateRiskEvent, ExtractionResult, IntegrityResult } from './sf.types';

const logger = createLogger('AggregateRisk');

const FRAUD_THRESHOLD       = 60;
const HIGH_AMOUNT_THRESHOLD = 50_000;
const ENDPOINT_NAME         = process.env.FRAUD_SCORING_ENDPOINT_NAME ?? '';
const DOCUMENTS_BUCKET      = process.env.DOCUMENTS_BUCKET_NAME ?? '';

const PHI_TTL_DAYS     = 6 * 365;  // HIPAA minimum 6-year retention
const NON_PHI_TTL_DAYS = 90;

const sagemakerClient = ENDPOINT_NAME
  ? new SageMakerRuntimeClient({})
  : null;

const s3Client = new S3Client({});

function mergeExtractions(extractions: ExtractionResult[]) {
  const claimType          = extractions.find(e => e.claimType)?.claimType ?? null;
  const estimatedAmount    = Math.max(...extractions.map(e => e.estimatedAmount ?? 0)) || null;
  const incidentDate       = extractions.find(e => e.incidentDate)?.incidentDate ?? null;
  const descriptionSummary = extractions.find(e => e.descriptionSummary)?.descriptionSummary ?? null;
  const involvedParties    = [...new Set(extractions.flatMap(e => e.involvedParties ?? []))];
  const claimTypes         = new Set(extractions.map(e => e.claimType).filter(Boolean));
  return { claimType, estimatedAmount, incidentDate, descriptionSummary, involvedParties, claimTypes };
}

// Builds the feature vector that maps Step Function outputs to the trained
// XGBoost feature space (see ml/fraud_scoring_training.ipynb section 13).
// Feature order MUST match FEATURE_COLS in the notebook.
function buildFeatureVector(
  integrities:         IntegrityResult[],
  history:             { recentClaimCount: number; flagged: boolean },
  estimatedAmount:     number | null,
  involvedPartiesCount: number,
): number[] {
  const avgIntegrity   = integrities.reduce((s, i) => s + i.integrityScore, 0) / integrities.length;
  const anyAlteration  = integrities.some(i => i.possibleAlteration) ? 1 : 0;
  const anyLowQuality  = integrities.some(i => i.lowQualityDocument);
  const anyInconsistent = integrities.some(i => i.inconsistentParties) ? 1 : 0;

  // Map integrityScore (0–100) to incident_severity ordinal (1–4)
  // Low integrity → high severity (more likely fraud signal)
  const incidentSeverity = avgIntegrity >= 80 ? 1 : avgIntegrity >= 60 ? 2 : avgIntegrity >= 40 ? 3 : 4;

  // Feature vector — order must match FEATURE_COLS in the notebook exactly.
  // Unknown fields (not derivable from SF outputs) use training-set medians.
  return [
    estimatedAmount     ?? 50_000, // total_claim_amount     (median default)
    0,                             // injury_claim           (unknown)
    anyAlteration * 25_000,        // property_claim         (proxy: alteration → damage)
    0,                             // vehicle_claim          (unknown)
    involvedPartiesCount || 1,     // number_of_vehicles_involved
    anyInconsistent,               // bodily_injuries        (proxy: party inconsistency)
    0,                             // witnesses              (unknown)
    anyAlteration,                 // property_damage        (1=YES, 0=NO)
    anyLowQuality ? 0 : 1,         // police_report_available (inverted from quality)
    incidentSeverity,              // incident_severity      (1–4)
    0,                             // incident_type          (median-encoded)
    0,                             // collision_type         (median-encoded)
    0,                             // authorities_contacted  (median-encoded)
    new Date().getMonth() + 1,     // incident_month         (current month)
    40,                            // age_bucket             (median bucket)
    60,                            // months_as_customer     (median ~5 years)
    0,                             // insured_sex            (median-encoded)
    1,                             // insured_education_level (median-encoded)
    0,                             // insured_occupation     (median-encoded)
    0,                             // insured_hobbies        (median-encoded)
    0,                             // insured_relationship   (median-encoded)
    0,                             // incident_state         (median-encoded)
    0,                             // auto_make              (median-encoded)
    0,                             // auto_model             (median-encoded)
    2015,                          // auto_year              (median)
    0,                             // capital_gains          (default 0 after noise)
    0,                             // capital_loss           (default 0 after noise)
    500,                           // policy_deductable      (median)
    1_200,                         // policy_annual_premium  (median)
    0,                             // umbrella_limit         (median)
    history.recentClaimCount,      // extra: recent claim count (appended)
    history.flagged ? 1 : 0,       // extra: history flagged
  ];
}

async function scoreFraudML(featureVector: number[]): Promise<number | null> {
  if (!sagemakerClient || !ENDPOINT_NAME) return null;

  try {
    const csvRow = featureVector.join(',');
    const cmd = new InvokeEndpointCommand({
      EndpointName: ENDPOINT_NAME,
      ContentType:  'text/csv',
      Accept:       'text/csv',
      Body:         Buffer.from(csvRow),
    });
    const response = await sagemakerClient.send(cmd);
    const body     = new TextDecoder().decode(response.Body as Uint8Array);
    const probability = parseFloat(body.trim());
    if (isNaN(probability)) throw new Error(`Unexpected ML response: ${body}`);
    return Math.min(Math.round(probability * 100), 100);
  } catch (err) {
    logger.warn('ML scoring failed — using rule-based fallback', { error: String(err) });
    return null;
  }
}

function computeRuleBasedScore(
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

// Tags all S3 documents belonging to a claim with phi=true or phi=false.
// This drives the lifecycle rule: 7 days for non-PHI, 2190 days for PHI.
// Errors are logged but do not fail the handler — tagging is best-effort;
// untagged objects simply have no expiry until the next run or manual action.
async function tagDocuments(documentKeys: string[], containsPHI: boolean): Promise<void> {
  if (!DOCUMENTS_BUCKET || !documentKeys.length) return;
  const tagValue = containsPHI ? 'true' : 'false';
  await Promise.allSettled(
    documentKeys.map(key =>
      s3Client.send(new PutObjectTaggingCommand({
        Bucket:  DOCUMENTS_BUCKET,
        Key:     key,
        Tagging: { TagSet: [{ Key: 'phi', Value: tagValue }] },
      })).catch(err => logger.warn('Failed to tag document', { key, error: String(err) }))
    )
  );
  logger.info('Tagged documents', { count: documentKeys.length, phi: tagValue });
}

function toEpochSeconds(daysFromNow: number): number {
  return Math.floor((Date.now() + daysFromNow * 86_400_000) / 1000);
}

export const handler: Handler<AggregateRiskEvent> = async (event) => {
  const { claimId, phase1Results, phase2Results } = event;

  // Error path — tag documents as non-PHI (unknown claimType) and set short TTL.
  // Documents from failed claims are not classified; 90-day DynamoDB TTL allows investigation.
  if (!phase1Results) {
    const { error, cause } = event as unknown as { error: string; cause: string };
    let errorReason = error;
    try { errorReason = (JSON.parse(cause) as { errorMessage?: string }).errorMessage ?? error; } catch { /* raw */ }
    logger.warn('Claim analysis failed', { claimId, error });

    const claim = await ClaimEntity.findById(claimId);
    if (claim) {
      const documentKeys = (claim.documents ?? []).map(d => d.key);
      await tagDocuments(documentKeys, false);
    }

    await ClaimEntity.update(claimId, {
      status:      'error',
      errorReason,
      containsPHI: false,
      ttl:         toEpochSeconds(NON_PHI_TTL_DAYS),
      processedAt: new Date().toISOString(),
    });
    return;
  }

  const [perDocResults, history] = phase1Results;
  const [consistency, coverage]  = phase2Results;

  logger.info('Aggregating risk', { claimId, docs: perDocResults.length });

  const extractions = perDocResults.map(([ext]) => ext);
  const integrities = perDocResults.map(([, int]) => int);

  const { claimType, estimatedAmount, incidentDate, descriptionSummary, involvedParties, claimTypes } =
    mergeExtractions(extractions);

  // Rule-based signals always run — provide explainability regardless of scoring path
  const { score: rulesScore, signals } = computeRuleBasedScore(
    integrities, history, consistency?.contradictions ?? [], claimTypes,
  );

  // ML scoring: if endpoint configured, override the numeric score; keep rule signals
  const featureVector = buildFeatureVector(integrities, history, estimatedAmount, involvedParties.length);
  const mlScore       = await scoreFraudML(featureVector);
  const fraudScore    = mlScore ?? rulesScore;
  const scoringMethod = mlScore !== null ? 'ml' : 'rules';

  logger.info('Risk scored', { claimId, fraudScore, scoringMethod, mlScore, rulesScore });

  const requiresHumanReview = fraudScore >= FRAUD_THRESHOLD;
  const priority = (
    requiresHumanReview || (estimatedAmount !== null && estimatedAmount > HIGH_AMOUNT_THRESHOLD)
      ? 'high' : fraudScore >= 30 ? 'medium' : 'low'
  ) as 'high' | 'medium' | 'low';

  logger.info('Risk aggregated', { claimId, fraudScore, consistent: consistency?.consistent });

  // HIPAA — health claims contain PHI: apply 6-year retention on S3 and DynamoDB.
  const containsPHI = claimType === 'health';
  const ttl         = toEpochSeconds(containsPHI ? PHI_TTL_DAYS : NON_PHI_TTL_DAYS);

  // Tag S3 documents before updating DynamoDB so lifecycle rules apply immediately.
  const claim        = await ClaimEntity.findById(claimId);
  const documentKeys = (claim?.documents ?? []).map(d => d.key);
  await tagDocuments(documentKeys, containsPHI);

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
    fraudScoringMethod:  scoringMethod,
    coverageApplies:     coverage.coverageApplies,
    coverageClause:      coverage.referenceClause ?? undefined,
    crossDocConsistent:  consistency?.consistent ?? true,
    crossDocObservations: consistency?.crossDocObservations,
    requiresHumanReview,
    priority,
    containsPHI,
    ttl,
    processedAt:         new Date().toISOString(),
    documentAnalyses,
  });
};
