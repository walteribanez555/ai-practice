import type { Pool, PoolClient, QueryResultRow } from 'pg';

type Row = Record<string, unknown>;
type WhereClause = Record<string, unknown>;
type OrderDirection = 'ASC' | 'DESC';

interface QueryRunner {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

export interface FindManyOptions {
  where?: WhereClause;
  select?: string[];
  orderBy?: Record<string, OrderDirection>;
  limit?: number;
  offset?: number;
}

export interface FindOneOptions {
  where: WhereClause;
  select?: string[];
}

export interface UpdateOptions {
  where: WhereClause;
  data: Record<string, unknown>;
}

export interface OrmContext {
  table<T extends Row = Row>(name: string): TableQueryBuilder<T>;
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
}

function buildWhere(where: WhereClause, paramOffset = 0): { clause: string; params: unknown[] } {
  const entries = Object.entries(where);
  if (!entries.length) return { clause: '', params: [] };

  const params: unknown[] = [];
  const conditions = entries.map(([key, value]) => {
    if (value === null) return `"${key}" IS NULL`;
    params.push(value);
    return `"${key}" = $${paramOffset + params.length}`;
  });

  return { clause: `WHERE ${conditions.join(' AND ')}`, params };
}

function buildSelect(select?: string[]): string {
  if (!select?.length) return '*';
  return select.map((col) => `"${col}"`).join(', ');
}

export class TableQueryBuilder<T extends Row = Row> {
  constructor(private readonly runner: QueryRunner, private readonly table: string) {}

  async findMany(options: FindManyOptions = {}): Promise<T[]> {
    const cols = buildSelect(options.select);
    const { clause, params } = buildWhere(options.where ?? {});

    const orderClause = options.orderBy
      ? `ORDER BY ${Object.entries(options.orderBy)
          .map(([col, dir]) => `"${col}" ${dir}`)
          .join(', ')}`
      : '';

    const limitClause  = options.limit  !== undefined ? `LIMIT ${options.limit}`   : '';
    const offsetClause = options.offset !== undefined ? `OFFSET ${options.offset}` : '';

    const sql = `SELECT ${cols} FROM "${this.table}" ${clause} ${orderClause} ${limitClause} ${offsetClause}`.trim();
    const { rows } = await this.runner.query<T>(sql, params);
    return rows;
  }

  async findOne(options: FindOneOptions): Promise<T | null> {
    const cols = buildSelect(options.select);
    const { clause, params } = buildWhere(options.where);
    const sql = `SELECT ${cols} FROM "${this.table}" ${clause} LIMIT 1`;
    const { rows } = await this.runner.query<T>(sql, params);
    return rows[0] ?? null;
  }

  async create(data: Record<string, unknown>): Promise<T> {
    const keys   = Object.keys(data);
    const values = Object.values(data);
    const cols   = keys.map((k) => `"${k}"`).join(', ');
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const sql = `INSERT INTO "${this.table}" (${cols}) VALUES (${placeholders}) RETURNING *`;
    const { rows } = await this.runner.query<T>(sql, values);
    return rows[0];
  }

  async update(options: UpdateOptions): Promise<T | null> {
    const dataEntries = Object.entries(options.data);
    if (!dataEntries.length) throw new Error('update() requires at least one field in data');

    const setClauses  = dataEntries.map(([key], i) => `"${key}" = $${i + 1}`).join(', ');
    const dataValues  = dataEntries.map(([, v]) => v);
    const { clause, params: whereParams } = buildWhere(options.where, dataEntries.length);
    const sql = `UPDATE "${this.table}" SET ${setClauses} ${clause} RETURNING *`;
    const { rows } = await this.runner.query<T>(sql, [...dataValues, ...whereParams]);
    return rows[0] ?? null;
  }

  async delete(options: { where: WhereClause }): Promise<boolean> {
    const { clause, params } = buildWhere(options.where);
    if (!clause) throw new Error('delete() requires a where clause');
    const sql    = `DELETE FROM "${this.table}" ${clause}`;
    const result = await this.runner.query(sql, params);
    return (result.rowCount ?? 0) > 0;
  }
}

class TransactionOrm implements OrmContext {
  constructor(private readonly client: PoolClient) {}

  table<T extends Row = Row>(name: string): TableQueryBuilder<T> {
    return new TableQueryBuilder<T>(this.client, name);
  }

  async query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]> {
    const { rows } = await this.client.query<T>(sql, params);
    return rows;
  }
}

export class Orm implements OrmContext {
  constructor(private readonly pool: Pool) {}

  table<T extends Row = Row>(name: string): TableQueryBuilder<T> {
    return new TableQueryBuilder<T>(this.pool, name);
  }

  async query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]> {
    const { rows } = await this.pool.query<T>(sql, params);
    return rows;
  }

  async transaction<T>(fn: (trx: OrmContext) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(new TransactionOrm(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

export const createOrm = (pool: Pool): Orm => new Orm(pool);
