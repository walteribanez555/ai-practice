import type { Claim, DocumentRef, DocumentAnalysis } from '../../orm/entities/claim.entity';
import type { ClaimStatus, Coverage, ExtractedData, Priority } from './claim.types';

// ── Input DTOs ────────────────────────────────────────────────────────────────

export interface CreateClaimDto {
  clientId?:  string;   // adjuster may specify; client always uses own id
  policyId?:  string;
}

export interface AddDocumentDto {
  contentType:   string;  // 'pdf' | 'jpeg' | 'png'
  fileSizeBytes: number;
}

export interface AddDocumentResponseDto {
  documentKey: string;
  uploadUrl:   string;
  expiresIn:   number;
  mimeType:    string;
}

export interface ProcessClaimDto {
  extracted: ExtractedData;
  documentSignals?: {
    lowQualityDocument?: boolean;
    possibleAlteration?: boolean;
    inconsistentParties?: boolean;
  };
}

export interface DecisionDto {
  decision: 'approved' | 'rejected' | 'needs_info';
  note?:    string;
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
  id:                 string;
  status:             ClaimStatus;
  claimType:          string | null;
  estimatedAmount:    number | null;
  incidentDate:       string | null;
  descriptionSummary: string | null;
  coverageApplies:    Coverage | null;
  createdAt:          string;
  updatedAt:          string;
  processedAt:        string | null;
  documents:          DocumentRef[];
}

/** Full view for the adjuster — includes internal risk data. fraudScoringMethod is intentionally omitted (internal implementation detail). */
export interface ClaimAdjusterResponseDto extends ClaimClientResponseDto {
  clientId:            string;
  policyId:            string | null;
  involvedParties:     string[] | null;
  fraudRiskScore:      number | null;
  riskJustification:   string | null;
  requiresHumanReview: boolean;
  priority:            Priority | null;
  errorReason:         string | null;
  documentAnalyses:      DocumentAnalysis[];
  crossDocConsistent?:   boolean;
  crossDocObservations?: string;
  coverageClause?:       string;
  adjusterNote?:         string;
  decisionAt?:           string;
  decidedBy?:            string;
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
  documents:          c.documents          ?? [],
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
  documentAnalyses:      c.documentAnalyses      ?? [],
  crossDocConsistent:    c.crossDocConsistent,
  crossDocObservations:  c.crossDocObservations,
  coverageClause:        c.coverageClause,
  adjusterNote:          c.adjusterNote,
  decisionAt:            c.decisionAt,
  decidedBy:             c.decidedBy,
});
