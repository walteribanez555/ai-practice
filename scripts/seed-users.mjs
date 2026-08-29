/**
 * Seed default users into DynamoDB for local dev / testing.
 *
 * Usage:
 *   npm run seed:users
 *
 * Requires:
 *   - AWS credentials configured (aws configure or env vars)
 *   - USERS_TABLE_NAME env var (or set via --table flag)
 *
 * Default users created:
 *   adjuster@assistance.com  /  Adjuster123!  → role: adjuster
 *   client@assistance.com    /  Client123!    → role: client
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';

try { process.loadEnvFile('.env'); } catch { /* .env is optional */ }

const REGION     = process.env.AWS_DEFAULT_REGION ?? 'us-east-1';
const TABLE_NAME = process.env.USERS_TABLE_NAME
  ?? process.argv.find(a => a.startsWith('--table='))?.split('=')[1];

if (!TABLE_NAME) {
  console.error('USERS_TABLE_NAME is not set. Pass it via env or --table=<name>');
  process.exit(1);
}

const client    = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(client);

const SEED_USERS = [
  { email: 'adjuster@assistance.com', password: 'Adjuster123!', role: 'adjuster' },
  { email: 'client@assistance.com',   password: 'Client123!',   role: 'client'   },
];

async function userExists(email) {
  const res = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { email },
  }));
  return !!res.Item;
}

async function seedUser({ email, password, role }) {
  if (await userExists(email)) {
    console.log(`  ↳ skipped (already exists): ${email}`);
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);

  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      email,
      userId:    randomUUID(),
      role,
      passwordHash,
      createdAt: new Date().toISOString(),
    },
  }));

  console.log(`  ✅ created: ${email}  role: ${role}`);
}

console.log(`\nSeeding users → ${TABLE_NAME}\n`);

for (const user of SEED_USERS) {
  await seedUser(user);
}

console.log('\nDone.\n');
console.log('Test credentials:');
console.log('  adjuster@assistance.com  /  Adjuster123!');
console.log('  client@assistance.com    /  Client123!\n');
