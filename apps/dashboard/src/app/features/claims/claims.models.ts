export type ClaimStatus   = 'draft' | 'pending' | 'processing' | 'processed' | 'approved' | 'rejected' | 'needs_info' | 'error';
export type ClaimPriority = 'high' | 'medium' | 'low';
export type Coverage      = 'full' | 'partial' | 'none' | 'unknown';

export interface DocumentAnalysis {
  documentKey:         string;
  contentType:         string;
  claimType:           string | null;
  estimatedAmount:     number | null;
  incidentDate:        string | null;
  involvedParties:     string[] | null;
  descriptionSummary:  string | null;
  lowQualityDocument:  boolean;
  possibleAlteration:  boolean;
  inconsistentParties: boolean;
  observations:        string;
  integrityScore:      number;
}

// GDPR Art. 22 — included in every processed claim visible to the data subject
export interface AutomatedProcessingNotice {
  applied:        boolean;
  description:    string;
  rightToContest: string;
}

export interface Claim {
  id:                  string;
  status:              ClaimStatus;
  claimType:           string | null;
  estimatedAmount:     number | null;
  incidentDate:        string | null;
  involvedParties:     string[] | null;   // Art. 15 — always present in client response
  descriptionSummary:  string | null;
  coverageApplies:     Coverage | null;
  requiresHumanReview: boolean;           // Art. 22 — right to know if flagged
  automatedProcessing: AutomatedProcessingNotice | null;  // Art. 22 notice
  gdprConsentAt:       string | null;     // Art. 13 — consent timestamp
  gdprErasedAt:        string | null;     // Art. 17 — set when anonymized
  createdAt:           string;
  updatedAt:           string;
  processedAt:         string | null;
  documents?:          { key: string; contentType: string; fileSizeBytes?: number }[];
  // adjuster-only fields
  clientId?:           string;
  policyId?:           string | null;
  fraudRiskScore?:     number | null;
  riskJustification?:  string | null;
  priority?:           ClaimPriority | null;
  errorReason?:        string | null;
  documentAnalyses?:   DocumentAnalysis[];
  crossDocConsistent?:   boolean;
  crossDocObservations?: string;
  coverageClause?:       string;
  adjusterNote?:         string;
  decisionAt?:           string;
  decidedBy?:            string;
}

export interface CreateClaimPayload {
  documentKey:   string;
  contentType:   string;
  fileSizeBytes: number;
}

export interface UpdateClaimPayload {
  claimType?:         string;
  estimatedAmount?:   number;
  incidentDate?:      string;
  involvedParties?:   string[];
  descriptionSummary?: string;
}

export interface PresignResponse {
  documentKey: string;
  uploadUrl:   string;
  expiresIn:   number;
  mimeType:    string;
}
