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

export interface Claim {
  id:                  string;
  status:              ClaimStatus;
  claimType:           string | null;
  estimatedAmount:     number | null;
  incidentDate:        string | null;
  descriptionSummary:  string | null;
  coverageApplies:     Coverage | null;
  createdAt:           string;
  updatedAt:           string;
  processedAt:         string | null;
  // adjuster-only fields (null for client view)
  clientId?:           string;
  policyId?:           string | null;
  involvedParties?:    string[] | null;
  fraudRiskScore?:     number | null;
  riskJustification?:  string | null;
  requiresHumanReview?: boolean;
  priority?:           ClaimPriority | null;
  errorReason?:          string | null;
  documents?:            { key: string; contentType: string; fileSizeBytes?: number }[];
  documentAnalyses?:     DocumentAnalysis[];
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
