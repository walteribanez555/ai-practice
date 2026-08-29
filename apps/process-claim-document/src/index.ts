/**
 * Entry point for AWS Lambda.
 */

import { handle } from 'hono/aws-lambda';
import { app } from './app';

const honoHandler = handle(app);

export const handler = async (
  event: Parameters<typeof honoHandler>[0],
  context: Parameters<typeof honoHandler>[1],
) => honoHandler(event, context);
