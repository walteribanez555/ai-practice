/**
 * GSI lifecycle manager for DynamoDB tables.
 *
 * DynamoDB only allows one GSI creation or deletion per UpdateTable call.
 * This script applies GSI changes sequentially, waiting for each to become
 * ACTIVE before proceeding — something CloudFormation cannot do in a single deploy.
 *
 * Usage:
 *   npm run gsi:add    -- --table assistance-prod-claims --index my-index --pk clientId --sk createdAt
 *   npm run gsi:remove -- --table assistance-prod-claims --index my-index
 *   npm run gsi:list   -- --table assistance-prod-claims
 */

import {
  DynamoDBClient,
  DescribeTableCommand,
  UpdateTableCommand,
  type GlobalSecondaryIndexUpdate,
} from '@aws-sdk/client-dynamodb';

const client = new DynamoDBClient({ region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1' });

// ── Helpers ───────────────────────────────────────────────────────────────────

async function waitForTableActive(tableName: string): Promise<void> {
  process.stdout.write(`Waiting for table "${tableName}" to be ACTIVE`);
  while (true) {
    const res = await client.send(new DescribeTableCommand({ TableName: tableName }));
    const status = res.Table?.TableStatus;
    const gsiStatuses = res.Table?.GlobalSecondaryIndexes?.map((g) => g.IndexStatus) ?? [];

    if (status === 'ACTIVE' && gsiStatuses.every((s) => s === 'ACTIVE')) {
      process.stdout.write(' ✅\n');
      return;
    }

    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

async function listGSIs(tableName: string): Promise<void> {
  const res = await client.send(new DescribeTableCommand({ TableName: tableName }));
  const gsis = res.Table?.GlobalSecondaryIndexes ?? [];

  if (!gsis.length) {
    console.log(`Table "${tableName}" has no GSIs.`);
    return;
  }

  console.log(`GSIs on "${tableName}":`);
  for (const gsi of gsis) {
    const pk = gsi.KeySchema?.find((k) => k.KeyType === 'HASH')?.AttributeName;
    const sk = gsi.KeySchema?.find((k) => k.KeyType === 'RANGE')?.AttributeName;
    console.log(`  • ${gsi.IndexName}  (pk: ${pk}, sk: ${sk ?? '-'})  [${gsi.IndexStatus}]`);
  }
}

async function addGSI(tableName: string, indexName: string, pk: string, sk?: string): Promise<void> {
  console.log(`Adding GSI "${indexName}" to table "${tableName}"...`);

  const attributeDefinitions = [
    { AttributeName: pk, AttributeType: 'S' as const },
    ...(sk ? [{ AttributeName: sk, AttributeType: 'S' as const }] : []),
  ];

  const keySchema = [
    { AttributeName: pk, KeyType: 'HASH' as const },
    ...(sk ? [{ AttributeName: sk, KeyType: 'RANGE' as const }] : []),
  ];

  const update: GlobalSecondaryIndexUpdate = {
    Create: {
      IndexName: indexName,
      KeySchema: keySchema,
      Projection: { ProjectionType: 'ALL' },
    },
  };

  await client.send(new UpdateTableCommand({
    TableName: tableName,
    AttributeDefinitions: attributeDefinitions,
    GlobalSecondaryIndexUpdates: [update],
  }));

  await waitForTableActive(tableName);
  console.log(`GSI "${indexName}" is now ACTIVE.`);
}

async function removeGSI(tableName: string, indexName: string): Promise<void> {
  console.log(`Removing GSI "${indexName}" from table "${tableName}"...`);

  await client.send(new UpdateTableCommand({
    TableName: tableName,
    GlobalSecondaryIndexUpdates: [
      { Delete: { IndexName: indexName } },
    ],
  }));

  await waitForTableActive(tableName);
  console.log(`GSI "${indexName}" removed.`);
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

function getArg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
}

(async () => {
  try { process.loadEnvFile('.env'); } catch {}

  const table = getArg('table');
  const index = getArg('index');

  if (!table) {
    console.error('--table is required');
    process.exit(1);
  }

  switch (command) {
    case 'list':
      await listGSIs(table);
      break;

    case 'add': {
      if (!index) { console.error('--index is required'); process.exit(1); }
      const pk = getArg('pk');
      const sk = getArg('sk');
      if (!pk) { console.error('--pk is required'); process.exit(1); }
      await addGSI(table, index, pk, sk);
      break;
    }

    case 'remove': {
      if (!index) { console.error('--index is required'); process.exit(1); }
      await removeGSI(table, index);
      break;
    }

    default:
      console.error('Unknown command. Use: list | add | remove');
      process.exit(1);
  }
})();
