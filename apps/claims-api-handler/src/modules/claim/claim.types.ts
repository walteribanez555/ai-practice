export type ClaimStatus   = 'draft' | 'pending' | 'processing' | 'processed' | 'error';
export type Coverage      = 'covered' | 'not_covered' | 'requires_review';
export type Priority      = 'high' | 'medium' | 'low';
export type ContentType   = 'jpeg' | 'png' | 'pdf';
export type ClaimType     = 'auto' | 'health' | 'home' | 'theft' | 'other';

export const ALLOWED_CONTENT_TYPES: ContentType[] = ['jpeg', 'png', 'pdf'];

export const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024; // 15 MB

export const FRAUD_THRESHOLD = 60;           // score >= this → requiresHumanReview = true
export const HIGH_AMOUNT_THRESHOLD = 50_000; // amount > this → priority high
export const MAX_CLAIMS_30_DAYS = 2;         // recent claims before fraud signal fires

export const FRAUD_SIGNALS = {
  DATE_INCONSISTENT:    20,
  AMOUNT_OUT_OF_RANGE:  25,
  LOW_QUALITY_DOCUMENT: 20,
  PARTIES_INCONSISTENT: 20,
  HISTORY_EXCEEDED:     25,
} as const;

export const TYPICAL_AMOUNT_RANGE: Record<ClaimType, { min: number; max: number }> = {
  auto:   { min: 500,   max: 80_000  },
  health: { min: 200,   max: 150_000 },
  home:   { min: 1_000, max: 200_000 },
  theft:  { min: 100,   max: 50_000  },
  other:  { min: 0,     max: 500_000 },
};

export interface ExtractedData {
  claimType:         string | null;
  estimatedAmount:   number | null;
  incidentDate:      string | null; // ISO date YYYY-MM-DD
  involvedParties:   string[] | null;
  descriptionSummary: string | null;
}

export interface FraudScoreResult {
  score:    number;
  signals:  string[];
}
