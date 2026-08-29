/**
 * Lambda entry point.
 * Secrets are loaded once per container (cold start) before the first request.
 */

import { handle } from 'hono/aws-lambda';
import { loadSecrets } from './config/secrets';
import { app } from './app';

const honoHandler = handle(app);

export const handler = async (
  event: Parameters<typeof honoHandler>[0],
  context: Parameters<typeof honoHandler>[1],
) => {
  await loadSecrets();
  return honoHandler(event, context);
};
