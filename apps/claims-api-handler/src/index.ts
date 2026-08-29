/**
 * Lambda entry point.
 *
 * `waitForSecrets()` starts fetching at module load (cold start), in parallel
 * with Lambda's own initialization. By the time the first request arrives,
 * secrets are already resolved — no added latency on the hot path.
 */

import { handle } from 'hono/aws-lambda';
import { waitForSecrets } from './config/secrets';
import { app } from './app';

const honoHandler = handle(app);

export const handler = async (
  event: Parameters<typeof honoHandler>[0],
  context: Parameters<typeof honoHandler>[1],
) => {
  await waitForSecrets();
  return honoHandler(event, context);
};
