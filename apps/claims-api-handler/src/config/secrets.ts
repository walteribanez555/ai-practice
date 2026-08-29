import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createLogger } from './logger';

const logger = createLogger('Secrets');
const client = new SecretsManagerClient({});

/**
 * Starts fetching secrets immediately when the module is loaded (cold start).
 * The handler awaits this promise — by the time the first request arrives,
 * the fetch is already in flight or complete, so there is no extra latency.
 *
 * In local development APP_SECRET_ARN is absent, so the promise resolves instantly.
 */
const _ready: Promise<void> = (async () => {
  const arn = process.env.APP_SECRET_ARN;
  if (!arn) {
    logger.debug('APP_SECRET_ARN not set — skipping secret load (local dev)');
    return;
  }

  const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  const values = JSON.parse(res.SecretString ?? '{}') as Record<string, string>;

  for (const [key, value] of Object.entries(values)) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }

  logger.debug('Secrets loaded', { arn });
})();

/** Await this in the handler to ensure secrets are ready before processing. */
export const waitForSecrets = (): Promise<void> => _ready;
