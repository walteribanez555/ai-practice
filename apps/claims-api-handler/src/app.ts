/**
 * Hono app — shared between Lambda (index.ts) and local server (main.ts).
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { config, createLogger } from './config';
import { claimRouter } from './modules/claim/claim.module';

const logger = createLogger('App');
const { origins, methods, headers } = config.getValue('cors');

export const app = new Hono();

// ── CORS ──────────────────────────────────────────────────────────────────────

const corsOrigin = origins.length === 1 && origins[0] === '*'
  ? '*'
  : (origin: string) => (origins.includes(origin) ? origin : origins[0]);

app.use('*', cors({
  origin: corsOrigin,
  allowMethods: methods as string[],
  allowHeaders: headers,
  exposeHeaders: headers,
  credentials: true,
}));

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/', (c) => {
  logger.info('Root request');
  return c.json({ message: 'Hello from serverless' });
});

const v1 = new Hono();

v1.get('/health', (c) => {
  logger.info('Health check');
  return c.json({ status: 'ok' });
});

v1.route('/claims', claimRouter);

app.route('/api/v1', v1);
