import { Pool } from 'pg';
import { createLogger } from './logger';
import { createOrm } from '../orm/orm';

const logger = createLogger('DB');

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

export const pool = new Pool({
  connectionString: url,
  min: 1,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export const db = createOrm(pool);

pool.on('connect', () => logger.debug('New client connected to pool'));
pool.on('error', (err) => logger.error('Idle pool client error', err));
