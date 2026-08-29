/**
 * Generic DynamoDB table wrapper using DocumentClient.
 *
 * Covers the common access patterns for a single-table with a simple PK (id).
 * GSI queries are handled via `queryIndex`.
 *
 * Usage:
 *   const table = new DynamoTable<Claim>(docClient, 'my-table');
 *   await table.get('uuid');
 *   await table.put(item);
 *   await table.update('uuid', { status: 'procesado' });
 *   await table.queryIndex({ indexName: 'status-createdAt-index', pk: { name: 'status', value: 'pendiente' } });
 */

import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface QueryIndexOptions {
  indexName: string;
  pk: { name: string; value: string };
  sk?: { name: string; operator: '>=' | '<=' | 'between' | 'begins_with'; value: string; value2?: string };
  limit?: number;
  scanIndexForward?: boolean;
}

// ── Update expression builder ─────────────────────────────────────────────────

function buildUpdateExpression(updates: Record<string, unknown>): {
  UpdateExpression: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues: Record<string, unknown>;
} {
  const sets: string[]    = [];
  const removes: string[] = [];
  const names:  Record<string, string>  = {};
  const values: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(updates)) {
    const n = `#${key}`;
    names[n] = key;

    if (value === null || value === undefined) {
      removes.push(n);
    } else {
      const v = `:${key}`;
      values[v] = value;
      sets.push(`${n} = ${v}`);
    }
  }

  const parts: string[] = [];
  if (sets.length)    parts.push(`SET ${sets.join(', ')}`);
  if (removes.length) parts.push(`REMOVE ${removes.join(', ')}`);

  return {
    UpdateExpression: parts.join(' '),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
}

// ── Table ─────────────────────────────────────────────────────────────────────

export class DynamoTable<T extends Record<string, unknown>> {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async get(id: string): Promise<T | null> {
    return this.getByPk({ id });
  }

  async getByPk(key: Record<string, unknown>): Promise<T | null> {
    const res = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: key,
    }));
    return (res.Item as T) ?? null;
  }

  async put(item: T): Promise<T> {
    await this.client.send(new PutCommand({
      TableName: this.tableName,
      Item: item,
    }));
    return item;
  }

  async update(id: string, updates: Partial<T>): Promise<T | null> {
    const { UpdateExpression, ExpressionAttributeNames, ExpressionAttributeValues } =
      buildUpdateExpression(updates as Record<string, unknown>);

    if (!UpdateExpression) return this.get(id);

    const res = await this.client.send(new UpdateCommand({
      TableName: this.tableName,
      Key: { id },
      UpdateExpression,
      ExpressionAttributeNames,
      ExpressionAttributeValues,
      ReturnValues: 'ALL_NEW',
    }));

    return (res.Attributes as T) ?? null;
  }

  async delete(id: string): Promise<boolean> {
    const res = await this.client.send(new DeleteCommand({
      TableName: this.tableName,
      Key: { id },
      ReturnValues: 'ALL_OLD',
    }));
    return !!res.Attributes;
  }

  async queryIndex(options: QueryIndexOptions): Promise<T[]> {
    const names:  Record<string, string>  = { '#pk': options.pk.name };
    const values: Record<string, unknown> = { ':pkv': options.pk.value };

    let keyCondition = '#pk = :pkv';

    if (options.sk) {
      const { name, operator, value, value2 } = options.sk;
      names['#sk']  = name;
      values[':skv'] = value;

      if (operator === 'between' && value2 !== undefined) {
        values[':skv2'] = value2;
        keyCondition += ' AND #sk BETWEEN :skv AND :skv2';
      } else if (operator === 'begins_with') {
        keyCondition += ' AND begins_with(#sk, :skv)';
      } else {
        keyCondition += ` AND #sk ${operator} :skv`;
      }
    }

    const res = await this.client.send(new QueryCommand({
      TableName:                 this.tableName,
      IndexName:                 options.indexName,
      KeyConditionExpression:    keyCondition,
      ExpressionAttributeNames:  names,
      ExpressionAttributeValues: values,
      Limit:                     options.limit,
      ScanIndexForward:          options.scanIndexForward ?? false,
    }));

    return (res.Items as T[]) ?? [];
  }

  async scan(): Promise<T[]> {
    const res = await this.client.send(new ScanCommand({
      TableName: this.tableName,
    }));
    return (res.Items as T[]) ?? [];
  }
}
