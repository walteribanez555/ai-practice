// ── Shared Step Functions types ───────────────────────────────────────────────

export interface DocumentRef {
  key:           string;
  contentType:   string;
  fileSizeBytes?: number;
}

// State machine entry point
export interface StateMachineInput {
  claimId:      string;
  clientId:     string;
  policyId?:    string;
  documents:    DocumentRef[];
  claimContext: string;
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

export interface SynthesizeDocsInput {
  claimId:    string;
  extractions: Array<[ExtractionResult, IntegrityResult]>;
}

export interface CheckCoverageInput {
  claimId:     string;
  policyId?:   string;
  extractions: Array<[ExtractionResult, IntegrityResult]>;
  claimContext?: string;
}

// ── Per-handler outputs ────────────────────────────────────────────────────────

export interface ExtractionResult {
  contentType:        string;
  documentKey:        string;
  claimType:          string | null;
  estimatedAmount:    number | null;
  incidentDate:       string | null;
  involvedParties:    string[] | null;
  descriptionSummary: string | null;
}

export interface IntegrityResult {
  documentKey:         string;
  lowQualityDocument:  boolean;
  possibleAlteration:  boolean;
  inconsistentParties: boolean;
  observations:        string;
  integrityScore:      number;
}

export interface HistoryResult {
  recentClaimCount: number;
  flagged:          boolean;
}

export interface ConsistencyResult {
  consistent:           boolean;
  contradictions:       string[];
  crossDocObservations: string;
}

export interface CoverageResult {
  coverageApplies: 'covered' | 'not_covered' | 'requires_review';
  referenceClause: string | null;
}

// ── Two-phase aggregate input ──────────────────────────────────────────────────
//
// Phase 1 (parallel): doc analysis + history  → $.phase1Results
// Phase 2 (parallel): synthesis + coverage    → $.phase2Results
// Final: AggregateRisk receives both

export interface AggregateRiskEvent {
  claimId:      string;
  clientId:     string;
  phase1Results: [
    Array<[ExtractionResult, IntegrityResult]>,  // Branch 0: per-doc results
    HistoryResult,                                // Branch 1: history
  ];
  phase2Results: [
    ConsistencyResult,  // Branch 0: cross-doc synthesis
    CoverageResult,     // Branch 1: policy coverage
  ];
}
