import { randomUUID } from 'crypto';
import { docClient, CLAIMS_TABLE } from '../../config/dynamo';
import { DynamoTable } from '../dynamo-table';
import type { ClaimStatus, Coverage, Priority } from '../../modules/claim/claim.types';

// ── Shape ─────────────────────────────────────────────────────────────────────

export interface Claim extends Record<string, unknown> {
  id: string;
  status: ClaimStatus;
  // Client info
  clientId: string;
  policyId?: string;
  // Document reference
  documentKey: string;
  contentType: string;
  fileSizeBytes: number;
  // Extracted fields (absent = could not be read with confidence)
  claimType?: string;
  estimatedAmount?: number;
  incidentDate?: string;        // YYYY-MM-DD
  involvedParties?: string[];
  descriptionSummary?: string;
  // Fraud risk (internal — never exposed to the client)
  fraudRiskScore?: number;
  riskJustification?: string;
  // Coverage decision
  coverageApplies?: Coverage;
  // Routing
  requiresHumanReview: boolean;
  priority?: Priority;
  // Error details (populated when status = error)
  errorReason?: string;
  // Timestamps (ISO strings — doubles as GSI sort keys)
  createdAt: string;
  updatedAt: string;
  processedAt?: string;
  // Optional DynamoDB TTL (epoch seconds)
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
    | 'coverageApplies'
    | 'requiresHumanReview'
    | 'priority'
    | 'errorReason'
    | 'processedAt'
    | 'updatedAt'
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
