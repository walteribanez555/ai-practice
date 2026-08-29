import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import type { Migration } from './base';

const MIGRATIONS_TABLE = '_migrations';

async function ensureTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "${MIGRATIONS_TABLE}" (
      id          TEXT        PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function getApplied(pool: Pool): Promise<Set<string>> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM "${MIGRATIONS_TABLE}" ORDER BY id`
  );
  return new Set(rows.map((r) => r.id));
}

async function loadMigrations(dir: string): Promise<Migration[]> {
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d{14}_\w+\.(ts|js)$/.test(f))
    .sort();

  const migrations: Migration[] = [];
  for (const file of files) {
    const mod = await import(path.join(dir, file));
    migrations.push(mod.default as Migration);
  }
  return migrations;
}

export async function runMigrations(pool: Pool): Promise<void> {
  await ensureTable(pool);
  const applied    = await getApplied(pool);
  const migrations = await loadMigrations(__dirname);
  const pending    = migrations.filter((m) => !applied.has(m.id));

  if (!pending.length) {
    console.log('[migrations] No pending migrations');
    return;
  }

  for (const migration of pending) {
    console.log(`[migrations] Applying: ${migration.id}`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await migration.up(pool);
      await client.query(
        `INSERT INTO "${MIGRATIONS_TABLE}" (id) VALUES ($1)`,
        [migration.id]
      );
      await client.query('COMMIT');
      console.log(`[migrations] Applied: ${migration.id}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[migrations] Failed: ${migration.id}`, err);
      throw err;
    } finally {
      client.release();
    }
  }
}

if (require.main === module) {
  try { process.loadEnvFile('.env'); } catch {}

  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }

  const pool = new Pool({ connectionString: url });
  runMigrations(pool)
    .then(() => { console.log('[migrations] Done'); process.exit(0); })
    .catch(() => process.exit(1))
    .finally(() => pool.end());
}
