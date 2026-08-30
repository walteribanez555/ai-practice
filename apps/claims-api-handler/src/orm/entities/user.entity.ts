import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../../config/dynamo';
import { DynamoTable } from '../dynamo-table';
import type { UserRole } from '../../app.types';

// ── Shape ─────────────────────────────────────────────────────────────────────

export interface User extends Record<string, unknown> {
  email:        string;   // PK
  userId:       string;
  role:         UserRole;
  passwordHash: string;
  createdAt:    string;
  // HIPAA training acknowledgment — set when the adjuster accepts the PHI access policy
  hipaaAcknowledgedAt?: string;
}

export type CreateUserInput = Omit<User, 'createdAt' | 'hipaaAcknowledgedAt'>;

// ── Table ─────────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`${name} is not set`);
  return val;
}

const USERS_TABLE = requireEnv('USERS_TABLE_NAME');
const table = new DynamoTable<User>(docClient, USERS_TABLE);

// ── Entity ────────────────────────────────────────────────────────────────────

export const UserEntity = {
  findByEmail(email: string): Promise<User | null> {
    return table.getByPk({ email });
  },

  create(input: CreateUserInput): Promise<User> {
    const item = { ...input, createdAt: new Date().toISOString() };
    return table.put(item as User);
  },

  // Users table uses email as PK, not id — use UpdateCommand directly.
  async acknowledgeHipaa(email: string): Promise<void> {
    await docClient.send(new UpdateCommand({
      TableName: USERS_TABLE,
      Key:       { email },
      UpdateExpression:             'SET #ack = :ts',
      ExpressionAttributeNames:     { '#ack': 'hipaaAcknowledgedAt' },
      ExpressionAttributeValues:    { ':ts': new Date().toISOString() },
    }));
  },
};
