import { randomUUID } from 'crypto';
import { docClient, CLAIMS_TABLE } from '../../config/dynamo';
import { DynamoTable } from '../dynamo-table';
import type { ClaimStatus, Coverage, Priority } from '../../modules/claim/claim.types';

// ── Shape ─────────────────────────────────────────────────────────────────────

export interface DocumentRef {
  key:           string;
  contentType:   string;
  fileSizeBytes?: number;
}

export interface DocumentAnalysis {
  documentKey:         string;
  contentType:         string;
  // Extraction results
  claimType:           string | null;
  estimatedAmount:     number | null;
  incidentDate:        string | null;
  involvedParties:     string[] | null;
  descriptionSummary:  string | null;
  // Integrity results
  lowQualityDocument:  boolean;
  possibleAlteration:  boolean;
  inconsistentParties: boolean;
  observations:        string;
  integrityScore:      number;
}

export interface Claim extends Record<string, unknown> {
  id: string;
  status: ClaimStatus;
  // Client info
  clientId: string;
  policyId?: string;
  // Document references — primary doc kept for backward compat; use documents[] for multi-doc
  documentKey: string;
  contentType: string;
  fileSizeBytes: number;
  documents?: DocumentRef[];
  documentAnalyses?: DocumentAnalysis[];
  // Extracted fields (absent = could not be read with confidence)
  claimType?: string;
  estimatedAmount?: number;
  incidentDate?: string;        // YYYY-MM-DD
  involvedParties?: string[];
  descriptionSummary?: string;
  // Fraud risk (internal — never exposed to the client)
  fraudRiskScore?: number;
  riskJustification?: string;
  fraudScoringMethod?: 'ml' | 'rules';
  // Coverage decision
  coverageApplies?:      Coverage;
  coverageClause?:       string;
  crossDocConsistent?:   boolean;
  crossDocObservations?: string;
  // Routing
  requiresHumanReview: boolean;
  priority?: Priority;
  // HIPAA — set by aggregate-risk after claimType is known.
  // true  → health claim (PHI): DynamoDB TTL = 6 years, S3 tag phi=true (2190-day lifecycle)
  // false → non-PHI claim:      DynamoDB TTL = 90 days,  S3 tag phi=false (7-day lifecycle)
  containsPHI?: boolean;
  // Error details (populated when status = error)
  errorReason?: string;
  // Timestamps (ISO strings — doubles as GSI sort keys)
  createdAt: string;
  updatedAt: string;
  processedAt?: string;
  // DynamoDB TTL (epoch seconds) — set by aggregate-risk based on containsPHI
  ttl?: number;
}

export type CreateClaimInput = Pick<
  Claim,
  'clientId' | 'documentKey' | 'contentType' | 'fileSizeBytes'
> & Partial<Pick<Claim, 'policyId'>>;

export type UpdateClaimInput = Partial<
  Pick<
    Claim,
    | 'status'
    | 'claimType'
    | 'estimatedAmount'
    | 'incidentDate'
    | 'involvedParties'
    | 'descriptionSummary'
    | 'fraudRiskScore'
    | 'riskJustification'
    | 'fraudScoringMethod'
    | 'coverageApplies'
    | 'requiresHumanReview'
    | 'priority'
    | 'containsPHI'
    | 'ttl'
    | 'errorReason'
    | 'processedAt'
    | 'updatedAt'
    | 'documentAnalyses'
    | 'coverageClause'
    | 'crossDocConsistent'
    | 'crossDocObservations'
  >
>;

// ── Table ─────────────────────────────────────────────────────────────────────

const table = new DynamoTable<Claim>(docClient, CLAIMS_TABLE);

// ── Entity ────────────────────────────────────────────────────────────────────

export const ClaimEntity = {

  findAll(): Promise<Claim[]> {
    return table.scan();
  },

  findById(id: string): Promise<Claim | null> {
    return table.get(id);
  },

  findByClientId(clientId: string): Promise<Claim[]> {
    return table.queryIndex({
      indexName: 'clientId-createdAt-index',
      pk: { name: 'clientId', value: clientId },
    });
  },

  findRecentByClientId(clientId: string, since: Date): Promise<Claim[]> {
    return table.queryIndex({
      indexName: 'clientId-createdAt-index',
      pk: { name: 'clientId', value: clientId },
      sk: { name: 'createdAt', operator: '>=', value: since.toISOString() },
    });
  },

  findByStatus(status: ClaimStatus): Promise<Claim[]> {
    return table.queryIndex({
      indexName: 'status-createdAt-index',
      pk: { name: 'status', value: status },
    });
  },

  findByPriority(priority: Priority): Promise<Claim[]> {
    return table.queryIndex({
      indexName: 'priority-createdAt-index',
      pk: { name: 'priority', value: priority },
    });
  },

  create(input: CreateClaimInput): Promise<Claim> {
    const now  = new Date().toISOString();
    const item: Claim = {
      id:                  randomUUID(),
      status:              'pending',
      clientId:            input.clientId,
      documentKey:         input.documentKey,
      contentType:         input.contentType,
      fileSizeBytes:       input.fileSizeBytes,
      requiresHumanReview: false,
      createdAt:           now,
      updatedAt:           now,
      ...(input.policyId ? { policyId: input.policyId } : {}),
    };
    return table.put(item);
  },

  update(id: string, input: UpdateClaimInput): Promise<Claim | null> {
    return table.update(id, { ...input, updatedAt: new Date().toISOString() });
  },

  delete(id: string): Promise<boolean> {
    return table.delete(id);
  },
};
