import type { Claim } from '../../orm/entities/claim.entity';
import type { ClaimStatus, Coverage, ExtractedData, Priority } from './claim.types';

// ── Input DTOs ────────────────────────────────────────────────────────────────

export interface CreateClaimDto {
  clientId: string;
  policyId?: string;
  documentKey: string;
  contentType: string;
  fileSizeBytes: number;
}

export interface ProcessClaimDto {
  extracted: ExtractedData;
  documentSignals?: {
    lowQualityDocument?: boolean;
    possibleAlteration?: boolean;
    inconsistentParties?: boolean;
  };
}

export interface UpdateClaimDto {
  claimType?: string;
  estimatedAmount?: number;
  incidentDate?: string;
  involvedParties?: string[];
  descriptionSummary?: string;
  coverageApplies?: Coverage;
}

// ── Response DTOs ─────────────────────────────────────────────────────────────

/** Fields visible to the end client — no internal risk data. */
export interface ClaimClientResponseDto {
  id: string;
  status: ClaimStatus;
  claimType: string | null;
  estimatedAmount: number | null;
  incidentDate: string | null;
  descriptionSummary: string | null;
  coverageApplies: Coverage | null;
  createdAt: string;
  updatedAt: string;
  processedAt: string | null;
}

/** Full view for the adjuster — includes internal risk data. */
export interface ClaimAdjusterResponseDto extends ClaimClientResponseDto {
  clientId: string;
  policyId: string | null;
  involvedParties: string[] | null;
  fraudRiskScore: number | null;
  riskJustification: string | null;
  requiresHumanReview: boolean;
  priority: Priority | null;
  errorReason: string | null;
}

// ── Mappers ───────────────────────────────────────────────────────────────────

export const toClientResponse = (c: Claim): ClaimClientResponseDto => ({
  id:                 c.id,
  status:             c.status,
  claimType:          c.claimType          ?? null,
  estimatedAmount:    c.estimatedAmount    ?? null,
  incidentDate:       c.incidentDate       ?? null,
  descriptionSummary: c.descriptionSummary ?? null,
  coverageApplies:    c.coverageApplies    ?? null,
  createdAt:          c.createdAt,
  updatedAt:          c.updatedAt,
  processedAt:        c.processedAt        ?? null,
});

export const toAdjusterResponse = (c: Claim): ClaimAdjusterResponseDto => ({
  ...toClientResponse(c),
  clientId:            c.clientId,
  policyId:            c.policyId            ?? null,
  involvedParties:     c.involvedParties      ?? null,
  fraudRiskScore:      c.fraudRiskScore       ?? null,
  riskJustification:   c.riskJustification    ?? null,
  requiresHumanReview: c.requiresHumanReview,
  priority:            c.priority             ?? null,
  errorReason:         c.errorReason          ?? null,
});
