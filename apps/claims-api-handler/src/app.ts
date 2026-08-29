import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { config, createLogger } from './config';
import { claimRouter } from './modules/claim/claim.module';
import { authRouter } from './modules/auth/auth.module';
import { uploadRouter } from './modules/upload/upload.module';
import type { AppEnv } from './app.types';

const logger = createLogger('App');
const { origins, methods, headers } = config.getValue('cors');

export const app = new Hono<AppEnv>();

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
  return c.json({ service: 'claims-api-handler', status: 'ok' });
});

const v1 = new Hono<AppEnv>();

v1.get('/health', (c) => {
  logger.info('Health check');
  return c.json({ status: 'ok' });
});

v1.route('/auth',   authRouter);    // public  — no auth required
v1.route('/upload', uploadRouter);  // protected — presigned S3 URLs
v1.route('/claims', claimRouter);   // protected — claim lifecycle

app.route('/api/v1', v1);
