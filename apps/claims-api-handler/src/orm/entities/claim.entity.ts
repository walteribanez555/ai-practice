import { randomUUID } from 'crypto';
import { docClient, CLAIMS_TABLE } from '../../config/dynamo';
import { DynamoTable } from '../dynamo-table';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { ClaimStatus, Coverage, Priority } from '../../modules/claim/claim.types';

// ── Shape ─────────────────────────────────────────────────────────────────────

export interface DocumentRef {
  key:           string;
  contentType:   string;
  fileSizeBytes?: number;
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

export type CreateClaimInput = Pick<Claim, 'clientId'> & Partial<Pick<Claim, 'policyId'>>;

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
      status:              'draft',
      clientId:            input.clientId,
      documentKey:         '',
      contentType:         '',
      fileSizeBytes:       0,
      documents:           [],
      requiresHumanReview: false,
      createdAt:           now,
      updatedAt:           now,
      ...(input.policyId ? { policyId: input.policyId } : {}),
    };
    return table.put(item);
  },

  async appendDocument(id: string, doc: DocumentRef): Promise<Claim | null> {
    const res = await docClient.send(new UpdateCommand({
      TableName:    CLAIMS_TABLE,
      Key:          { id },
      UpdateExpression: 'SET documents = list_append(if_not_exists(documents, :empty), :doc), updatedAt = :now',
      ExpressionAttributeValues: {
        ':doc':   [doc],
        ':empty': [],
        ':now':   new Date().toISOString(),
      },
      ReturnValues: 'ALL_NEW',
    }));
    return (res.Attributes as Claim) ?? null;
  },

  update(id: string, input: UpdateClaimInput): Promise<Claim | null> {
    return table.update(id, { ...input, updatedAt: new Date().toISOString() });
  },

  delete(id: string): Promise<boolean> {
    return table.delete(id);
  },
};
