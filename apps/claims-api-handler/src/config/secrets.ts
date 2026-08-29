import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createLogger } from './logger';

const logger = createLogger('Secrets');
const client = new SecretsManagerClient({});

/**
 * Secret loading strategy for Lambda:
 *
 *  Non-sensitive config  → CDK environment block (NODE_ENV, table names, etc.)
 *  Sensitive config      → Secrets Manager, fetched here at module load time
 *
 * The IIFE starts immediately when the module is imported (cold start),
 * running in parallel with the rest of Lambda initialization.
 * The handler awaits the settled promise — if it rejected, the Lambda
 * fails fast on the first invocation rather than silently missing config.
 *
 * Local dev: APP_SECRET_ARN is absent → resolves immediately, .env file wins.
 */
const _ready: Promise<void> = (async () => {
  const arn = process.env.APP_SECRET_ARN;
  if (!arn) {
    logger.debug('APP_SECRET_ARN not set — local dev mode');
    return;
  }

  const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));

  if (!res.SecretString) {
    throw new Error(`Secret ${arn} exists but has no string value`);
  }

  const values = JSON.parse(res.SecretString) as Record<string, string>;

  for (const [key, value] of Object.entries(values)) {
    // Never overwrite values already set by the CDK environment block
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }

  logger.debug('Secrets loaded', { keys: Object.keys(values) });
})();

/**
 * Await in the handler before processing any request.
 * On cold start the promise is already in flight — this is a near-zero
 * cost await on warm invocations (promise already settled).
 * If the fetch failed, this re-throws and the invocation fails immediately.
 */
export const waitForSecrets = (): Promise<void> => _ready;
