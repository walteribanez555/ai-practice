import type { Claim, DocumentRef, DocumentAnalysis } from '../../orm/entities/claim.entity';
import type { ClaimStatus, Coverage, ExtractedData, Priority } from './claim.types';

// ── Input DTOs ────────────────────────────────────────────────────────────────

export interface CreateClaimDto {
  clientId?:    string;   // adjuster may specify; client always uses own id
  policyId?:    string;
  // GDPR Art. 13 — client must explicitly acknowledge the data processing notice
  // before the claim is created. Pass true to record gdprConsentAt timestamp.
  gdprConsent?: boolean;
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

// GDPR Art. 22 — notice included in every processed claim response.
// Informs the data subject that automated scoring was applied and explains
// their right to request human review or contest the decision.
export interface AutomatedProcessingNotice {
  applied:         boolean;
  description:     string;
  rightToContest:  string;
}

/** Fields visible to the end client — Art. 15 (access) + Art. 22 (automated processing). */
export interface ClaimClientResponseDto {
  id:                   string;
  status:               ClaimStatus;
  claimType:            string | null;
  estimatedAmount:      number | null;
  incidentDate:         string | null;
  involvedParties:      string[] | null;   // Art. 15 — personal data the claimant has a right to see
  descriptionSummary:   string | null;
  coverageApplies:      Coverage | null;
  requiresHumanReview:  boolean;           // Art. 22 — right to know if flagged for human review
  automatedProcessing:  AutomatedProcessingNotice | null;  // Art. 22 notice
  gdprConsentAt:        string | null;     // Art. 13 — confirmation consent was recorded
  gdprErasedAt:         string | null;     // Art. 17 — present when claim was anonymized
  createdAt:            string;
  updatedAt:            string;
  processedAt:          string | null;
  documents:            DocumentRef[];
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

const AUTOMATED_PROCESSING_NOTICE: AutomatedProcessingNotice = {
  applied:        true,
  description:    'Your claim was analyzed by an automated AI system that assessed fraud indicators and determined handling priority. No final coverage or payment decision is made solely by automation.',
  rightToContest: 'You have the right to request human review of any automated assessment. Contact your adjuster or submit a review request referencing your claim ID.',
};

export const toClientResponse = (c: Claim): ClaimClientResponseDto => {
  const processed = ['processed', 'approved', 'rejected', 'needs_info'].includes(c.status);
  return {
    id:                  c.id,
    status:              c.status,
    claimType:           c.claimType          ?? null,
    estimatedAmount:     c.estimatedAmount    ?? null,
    incidentDate:        c.incidentDate       ?? null,
    involvedParties:     c.involvedParties    ?? null,
    descriptionSummary:  c.descriptionSummary ?? null,
    coverageApplies:     c.coverageApplies    ?? null,
    requiresHumanReview: c.requiresHumanReview,
    automatedProcessing: processed ? AUTOMATED_PROCESSING_NOTICE : null,
    gdprConsentAt:       c.gdprConsentAt      ?? null,
    gdprErasedAt:        c.gdprErasedAt       ?? null,
    createdAt:           c.createdAt,
    updatedAt:           c.updatedAt,
    processedAt:         c.processedAt        ?? null,
    documents:           c.documents          ?? [],
  };
};

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
