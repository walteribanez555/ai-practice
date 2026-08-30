// ── Shared Step Functions types ───────────────────────────────────────────────
// These flow through the state machine between Lambda handlers.

export interface DocumentRef {
  key:           string;
  contentType:   string;
  fileSizeBytes?: number;
}

// State machine entry point
export interface StateMachineInput {
  claimId:   string;
  clientId:  string;
  policyId?: string;
  documents: DocumentRef[];
}

// ── Per-handler inputs ─────────────────────────────────────────────────────────

export interface AnalyzeDocumentInput {
  claimId:  string;
  document: DocumentRef;
}

export interface CheckHistoryInput {
  claimId:  string;
  clientId: string;
}

export interface CheckCoverageInput {
  claimId:       string;
  policyId?:     string;
  claimContext?: string;  // free-text hint for the KB query (e.g. "auto colision")
}

// ── Per-handler outputs ────────────────────────────────────────────────────────

export interface ExtractionResult {
  documentKey:        string;
  claimType:          string | null;
  estimatedAmount:    number | null;
  incidentDate:       string | null;      // YYYY-MM-DD
  involvedParties:    string[] | null;
  descriptionSummary: string | null;
}

export interface IntegrityResult {
  documentKey:         string;
  lowQualityDocument:  boolean;
  possibleAlteration:  boolean;
  inconsistentParties: boolean;
  observations:        string;
  integrityScore:      number;            // 0–100, higher = more suspicious
}

export interface HistoryResult {
  recentClaimCount: number;
  flagged:          boolean;
}

export interface CoverageResult {
  coverageApplies: 'covered' | 'not_covered' | 'requires_review';
  referenceClause: string | null;
}

// ── Aggregate input ────────────────────────────────────────────────────────────
// Step Functions Parallel state emits an array of branch outputs.
// Branch 0 → Map output: per-document [ExtractionResult, IntegrityResult]
// Branch 1 → HistoryResult
// Branch 2 → CoverageResult

export interface AggregateRiskEvent {
  claimId:         string;
  clientId:        string;
  analysisResults: [
    Array<[ExtractionResult, IntegrityResult]>,
    HistoryResult,
    CoverageResult,
  ];
}
