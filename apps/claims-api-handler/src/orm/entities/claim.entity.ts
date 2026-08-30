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

export interface Claim extends Record<string, unknown> {
  id:                  string;
  status:              ClaimStatus;
  clientId:            string;
  policyId?:           string;
  documents?:          DocumentRef[];
  documentAnalyses?:   DocumentAnalysis[];
  // Extracted fields populated after processing
  claimType?:          string;
  estimatedAmount?:    number;
  incidentDate?:       string;
  involvedParties?:    string[];
  descriptionSummary?: string;
  fraudRiskScore?:     number;
  riskJustification?:  string;
  coverageApplies?:    Coverage;
  requiresHumanReview: boolean;
  priority?:           Priority;
  errorReason?:        string;
  deletedAt?:          string;
  adjusterNote?:       string;
  decisionAt?:         string;
  decidedBy?:          string;
  crossDocConsistent?: boolean;
  crossDocObservations?: string;
  coverageClause?:     string;
  createdAt:           string;
  updatedAt:           string;
  processedAt?:        string;
  ttl?:                number;
  // GDPR — Art. 13: timestamp when the claimant acknowledged the data processing notice
  gdprConsentAt?:      string;
  // GDPR — Art. 17: set when all personal data was anonymized on erasure request
  gdprErasedAt?:       string;
}

export type CreateClaimInput = Pick<Claim, 'clientId'> & Partial<Pick<Claim, 'policyId' | 'gdprConsentAt'>>;

export type UpdateClaimInput = Partial<
  Pick<
    Claim,
    | 'status'
    | 'clientId'
    | 'policyId'
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
    | 'deletedAt'
    | 'documentAnalyses'
    | 'documents'
    | 'adjusterNote'
    | 'decisionAt'
    | 'decidedBy'
    | 'crossDocConsistent'
    | 'crossDocObservations'
    | 'coverageClause'
    | 'gdprConsentAt'
    | 'gdprErasedAt'
  >
>;

// ── Table ─────────────────────────────────────────────────────────────────────

const table = new DynamoTable<Claim>(docClient, CLAIMS_TABLE);

// ── Entity ────────────────────────────────────────────────────────────────────

export const ClaimEntity = {

  async findAll(): Promise<Claim[]> {
    const all = await table.scan();
    return all.filter(c => !c.deletedAt);
  },

  findById(id: string): Promise<Claim | null> {
    return table.get(id);
  },

  async findByClientId(clientId: string): Promise<Claim[]> {
    const all = await table.queryIndex({
      indexName: 'clientId-createdAt-index',
      pk: { name: 'clientId', value: clientId },
    });
    return all.filter(c => !c.deletedAt);
  },

  // Returns ALL claims including soft-deleted — used by GDPR erasure to ensure
  // no record is missed, even those hidden from normal queries.
  findAllByClientId(clientId: string): Promise<Claim[]> {
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
      documents:           [],
      requiresHumanReview: false,
      createdAt:           now,
      updatedAt:           now,
      ...(input.policyId      ? { policyId:      input.policyId      } : {}),
      ...(input.gdprConsentAt ? { gdprConsentAt: input.gdprConsentAt } : {}),
    };
    return table.put(item);
  },

  // GDPR Art. 17 — anonymize all personal fields in a single claim.
  // clientId is replaced with a sentinel so the record still exists for
  // audit/actuarial purposes without containing identifiable data.
  anonymize(id: string): Promise<Claim | null> {
    return table.update(id, {
      clientId:            'GDPR_ERASED',
      policyId:            undefined,
      documents:           [],
      documentAnalyses:    [],
      involvedParties:     undefined,
      descriptionSummary:  undefined,
      incidentDate:        undefined,
      claimType:           undefined,
      estimatedAmount:     undefined,
      riskJustification:   undefined,
      errorReason:         undefined,
      adjusterNote:        undefined,
      crossDocObservations: undefined,
      gdprErasedAt:        new Date().toISOString(),
      updatedAt:           new Date().toISOString(),
    } as UpdateClaimInput);
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

  // Soft delete — preserves the record for audit/compliance
  softDelete(id: string): Promise<Claim | null> {
    return table.update(id, { deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as UpdateClaimInput);
  },
};
