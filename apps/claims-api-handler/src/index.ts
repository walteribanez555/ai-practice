/**
 * Lambda entry point.
 *
 * `waitForSecrets()` starts fetching at module load (cold start), in parallel
 * with Lambda's own initialization. By the time the first request arrives,
 * secrets are already resolved — no added latency on the hot path.
 *
 * Health and root routes bypass the secrets check so the Lambda always
 * responds to health checks even when secrets are temporarily unavailable.
 */

import { handle } from 'hono/aws-lambda';
import { waitForSecrets } from './config/secrets';
import { app } from './app';

const honoHandler = handle(app);

const HEALTH_PATHS = new Set(['/', '/api/v1/health']);

export const handler = async (
  event: Parameters<typeof honoHandler>[0],
  context: Parameters<typeof honoHandler>[1],
) => {
  const path = (event as { rawPath?: string; path?: string }).rawPath
    ?? (event as { rawPath?: string; path?: string }).path
    ?? '/';

  if (!HEALTH_PATHS.has(path)) {
    await waitForSecrets();
  }

  return honoHandler(event, context);
};
