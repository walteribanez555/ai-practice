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
}

export type CreateUserInput = Omit<User, 'createdAt'>;

// ── Table ─────────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`${name} is not set`);
  return val;
}

const table = new DynamoTable<User>(docClient, requireEnv('USERS_TABLE_NAME'));

// ── Entity ────────────────────────────────────────────────────────────────────

export const UserEntity = {
  findByEmail(email: string): Promise<User | null> {
    return table.getByPk({ email });
  },

  create(input: CreateUserInput): Promise<User> {
    const item = { ...input, createdAt: new Date().toISOString() };
    return table.put(item as User);
  },
};
