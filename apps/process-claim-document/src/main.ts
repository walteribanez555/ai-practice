/**
 * Entry point for local development (Node.js HTTP server).
 */

try { process.loadEnvFile('.env'); } catch { /* .env is optional */ }

import { serve } from '@hono/node-server';
import { app } from './app';
import { createLogger } from './config';

const logger = createLogger('Server');
const PORT = Number(process.env.PORT) || 3000;

serve({ fetch: app.fetch, port: PORT }, (info) => {
  logger.info(`Server running on port ${info.port}`);
});
