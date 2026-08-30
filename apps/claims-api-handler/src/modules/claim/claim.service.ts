import { ClaimModel } from './claim.model';
import { BadRequestException, NotFoundException, UnprocessableException } from '../../common/exceptions';
import type { Claim, CreateClaimInput, DocumentRef } from '../../orm/entities/claim.entity';
import type { CreateClaimDto, ProcessClaimDto, UpdateClaimDto } from './claim.dto';
import { S3Service } from '../../common/services/s3.service';
import {
  ALLOWED_CONTENT_TYPES,
  FRAUD_SIGNALS,
  FRAUD_THRESHOLD,
  HIGH_AMOUNT_THRESHOLD,
  MAX_CLAIMS_30_DAYS,
  MAX_FILE_SIZE_BYTES,
  TYPICAL_AMOUNT_RANGE,
  type ClaimType,
  type Coverage,
  type ExtractedData,
  type FraudScoreResult,
  type Priority,
} from './claim.types';

export const ClaimService = {

  // ── Read ──────────────────────────────────────────────────────────────────

  findAll(): Promise<Claim[]> {
    return ClaimModel.findAll();
  },

  findById(id: string): Promise<Claim | null> {
    return ClaimModel.findById(id);
  },

  findByClientId(clientId: string): Promise<Claim[]> {
    return ClaimModel.findByClientId(clientId);
  },

  findByStatus(status: Claim['status']): Promise<Claim[]> {
    return ClaimModel.findByStatus(status);
  },

  // ── Create ────────────────────────────────────────────────────────────────

  async create(dto: CreateClaimDto): Promise<Claim> {
    return ClaimModel.create({
      clientId: dto.clientId ?? '',
      ...(dto.policyId    ? { policyId:      dto.policyId                } : {}),
      ...(dto.gdprConsent ? { gdprConsentAt: new Date().toISOString()    } : {}),
    });
  },

  markProcessing(id: string): Promise<Claim | null> {
    return ClaimModel.update(id, { status: 'processing' });
  },

  appendDocument(id: string, doc: DocumentRef): Promise<Claim | null> {
    return ClaimModel.appendDocument(id, doc);
  },

  // ── Process (legacy — kept for local dev; production uses Step Functions) ─

  async process(id: string, dto: ProcessClaimDto): Promise<Claim> {
    const claim = await ClaimModel.findById(id);
    if (!claim) throw new NotFoundException('Claim not found.', 'CLAIM_NOT_FOUND');

    if (claim.status !== 'pending') {
      throw new UnprocessableException(
        `Cannot process a claim in status "${claim.status}".`,
        'INVALID_STATUS_TRANSITION',
      );
    }

    await ClaimModel.update(id, { status: 'processing' });

    try {
      const { extracted, documentSignals = {} } = dto;

      const recentCount       = await ClaimService._countRecentClaims(claim.clientId);
      const fraud             = ClaimService._computeFraudScore(extracted, documentSignals, recentCount, new Date(claim.createdAt));
      const requiresReview    = fraud.score >= FRAUD_THRESHOLD;
      const coverageApplies   = ClaimService._computeCoverage(extracted.claimType, extracted.descriptionSummary);
      const priority          = ClaimService._computePriority(extracted.estimatedAmount, fraud.score, requiresReview);

      const updated = await ClaimModel.update(id, {
        status:              'processed',
        claimType:           extracted.claimType          ?? undefined,
        estimatedAmount:     extracted.estimatedAmount    ?? undefined,
        incidentDate:        extracted.incidentDate       ?? undefined,
        involvedParties:     extracted.involvedParties    ?? undefined,
        descriptionSummary:  extracted.descriptionSummary ?? undefined,
        fraudRiskScore:      fraud.score,
        riskJustification:   fraud.signals.join(' | ') || undefined,
        coverageApplies,
        requiresHumanReview: requiresReview,
        priority,
        processedAt:         new Date().toISOString(),
      });

      return updated!;
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Unknown processing error.';
      await ClaimModel.update(id, { status: 'error', errorReason: reason });
      throw err;
    }
  },

  // ── Update ────────────────────────────────────────────────────────────────

  async update(id: string, dto: UpdateClaimDto): Promise<Claim> {
    const claim = await ClaimModel.findById(id);
    if (!claim) throw new NotFoundException('Claim not found.', 'CLAIM_NOT_FOUND');

    const updated = await ClaimModel.update(id, {
      ...(dto.claimType          !== undefined && { claimType:          dto.claimType }),
      ...(dto.estimatedAmount    !== undefined && { estimatedAmount:    dto.estimatedAmount }),
      ...(dto.incidentDate       !== undefined && { incidentDate:       dto.incidentDate }),
      ...(dto.involvedParties    !== undefined && { involvedParties:    dto.involvedParties }),
      ...(dto.descriptionSummary !== undefined && { descriptionSummary: dto.descriptionSummary }),
      ...(dto.coverageApplies    !== undefined && { coverageApplies:    dto.coverageApplies }),
    });

    return updated!;
  },

  // ── Delete ────────────────────────────────────────────────────────────────

  softDelete(id: string) {
    return ClaimModel.softDelete(id);
  },

  // GDPR Art. 17 — erase all personal data for a clientId.
  // For each claim: deletes S3 documents then anonymizes the DynamoDB record.
  // The structural record (id, status, fraudRiskScore, timestamps) is retained
  // for audit and actuarial purposes — it contains no personal data after anonymization.
  async eraseByClientId(clientId: string, s3: S3Service): Promise<{ erased: number }> {
    const claims = await ClaimModel.findAllByClientId(clientId);
    if (!claims.length) return { erased: 0 };

    await Promise.all(
      claims.map(async (claim) => {
        // Delete S3 documents first — irreversible, so do before DynamoDB update
        const keys = (claim.documents ?? []).map(d => d.key);
        await Promise.allSettled(keys.map(key => s3.deleteObject(key)));
        // Anonymize the DynamoDB record
        await ClaimModel.anonymize(claim.id);
      })
    );

    return { erased: claims.length };
  },

  // GDPR Art. 20 — portable export of all data for a clientId.
  // Returns the full claim set including adjuster-visible fields so the
  // data subject receives everything that is processed about them.
  async exportByClientId(clientId: string): Promise<Claim[]> {
    return ClaimModel.findAllByClientId(clientId);
  },

  applyDecision(id: string, decision: 'approved' | 'rejected' | 'needs_info', note?: string, decidedBy?: string) {
    return ClaimModel.update(id, {
      status:       decision,
      adjusterNote: note,
      decisionAt:   new Date().toISOString(),
      decidedBy,
    });
  },

  // ── Business logic (pure functions) ──────────────────────────────────────

  _computeFraudScore(
    extracted: ExtractedData,
    documentSignals: NonNullable<ProcessClaimDto['documentSignals']>,
    recentClaimCount: number,
    claimCreatedAt: Date,
  ): FraudScoreResult {
    let score = 0;
    const signals: string[] = [];

    // Signal: incident date inconsistent with document creation date
    if (extracted.incidentDate) {
      const incident = new Date(extracted.incidentDate);
      const diffDays = Math.abs(
        (claimCreatedAt.getTime() - incident.getTime()) / (1000 * 60 * 60 * 24),
      );
      if (diffDays > 365) {
        score += FRAUD_SIGNALS.DATE_INCONSISTENT;
        signals.push(`Incident date is ${Math.round(diffDays)} days apart from claim creation.`);
      }
    }

    // Signal: amount outside the typical range for the claim type
    if (extracted.estimatedAmount !== null && extracted.claimType) {
      const type  = extracted.claimType as ClaimType;
      const range = TYPICAL_AMOUNT_RANGE[type] ?? TYPICAL_AMOUNT_RANGE.other;
      if (extracted.estimatedAmount < range.min || extracted.estimatedAmount > range.max) {
        score += FRAUD_SIGNALS.AMOUNT_OUT_OF_RANGE;
        signals.push(`Amount $${extracted.estimatedAmount} is outside the typical range [$${range.min}–$${range.max}] for "${type}".`);
      }
    }

    // Signal: low quality document or possible alteration
    if (documentSignals.lowQualityDocument || documentSignals.possibleAlteration) {
      score += FRAUD_SIGNALS.LOW_QUALITY_DOCUMENT;
      signals.push('Low quality document or possible alteration detected.');
    }

    // Signal: inconsistent parties across document sections
    if (documentSignals.inconsistentParties) {
      score += FRAUD_SIGNALS.PARTIES_INCONSISTENT;
      signals.push('Involved parties are inconsistent across document sections.');
    }

    // Signal: client exceeded recent claim limit in the last 30 days
    if (recentClaimCount > MAX_CLAIMS_30_DAYS) {
      score += FRAUD_SIGNALS.HISTORY_EXCEEDED;
      signals.push(`Client has ${recentClaimCount} claims in the last 30 days (limit: ${MAX_CLAIMS_30_DAYS}).`);
    }

    return { score: Math.min(score, 100), signals };
  },

  _computeCoverage(claimType: string | null, description: string | null): Coverage {
    // Rule: when in doubt, ALWAYS return requires_review.
    // Real implementation: match claim type + description against policy clauses via AI/NLP.
    if (!claimType || !description) return 'requires_review';
    return 'requires_review';
  },

  _computePriority(estimatedAmount: number | null, fraudScore: number, requiresReview: boolean): Priority {
    if (requiresReview || (estimatedAmount !== null && estimatedAmount > HIGH_AMOUNT_THRESHOLD)) return 'high';
    if (fraudScore >= 30 && fraudScore < FRAUD_THRESHOLD) return 'medium';
    return 'low';
  },

  async _countRecentClaims(clientId: string): Promise<number> {
    const since = new Date();
    since.setDate(since.getDate() - 30);
    const recent = await ClaimModel.findRecentByClientId(clientId, since);
    return recent.length;
  },
};
