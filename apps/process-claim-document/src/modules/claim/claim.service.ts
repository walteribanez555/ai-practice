import { ClaimModel } from './claim.model';
import { BadRequestException, NotFoundException, UnprocessableException } from '../../common/exceptions';
import { BedrockService } from '../../common/services/bedrock.service';
import type { DocumentSignals } from '../../common/services/bedrock.service';
import type { Claim, CreateClaimInput } from '../../orm/entities/claim.entity';
import type { CreateClaimDto, UpdateClaimDto } from './claim.dto';
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
    if (!ALLOWED_CONTENT_TYPES.includes(dto.contentType as never)) {
      throw new BadRequestException(
        `contentType "${dto.contentType}" is not allowed. Accepted: ${ALLOWED_CONTENT_TYPES.join(', ')}.`,
        'INVALID_CONTENT_TYPE',
      );
    }

    if (dto.fileSizeBytes > MAX_FILE_SIZE_BYTES) {
      const mb = (dto.fileSizeBytes / 1024 / 1024).toFixed(1);
      throw new BadRequestException(
        `File size ${mb} MB exceeds the 15 MB limit.`,
        'FILE_TOO_LARGE',
      );
    }

    const input: CreateClaimInput = {
      clientId:      dto.clientId,
      documentKey:   dto.documentKey,
      contentType:   dto.contentType,
      fileSizeBytes: dto.fileSizeBytes,
      ...(dto.policyId ? { policyId: dto.policyId } : {}),
    };

    return ClaimModel.create(input);
  },

  // ── Process ───────────────────────────────────────────────────────────────

  async process(id: string): Promise<Claim> {
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
      const { extracted, documentSignals } = await BedrockService.extractFromDocument(
        claim.documentKey,
        claim.contentType,
      );

      const recentCount     = await ClaimService._countRecentClaims(claim.clientId);
      const fraud           = ClaimService._computeFraudScore(extracted, documentSignals, recentCount, new Date(claim.createdAt));
      const requiresReview  = fraud.score >= FRAUD_THRESHOLD;
      const coverageApplies = ClaimService._computeCoverage(extracted.claimType, extracted.descriptionSummary);
      const priority        = ClaimService._computePriority(extracted.estimatedAmount, fraud.score, requiresReview);

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

  delete(id: string): Promise<boolean> {
    return ClaimModel.delete(id);
  },

  // ── Business logic (pure functions) ──────────────────────────────────────

  _computeFraudScore(
    extracted: ExtractedData,
    documentSignals: DocumentSignals,
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
