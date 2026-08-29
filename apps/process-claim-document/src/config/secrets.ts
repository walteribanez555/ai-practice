import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createLogger } from './logger';

const logger = createLogger('Secrets');
const client = new SecretsManagerClient({});

let loaded = false;

/**
 * Fetches the app secret from Secrets Manager and injects its keys into
 * process.env. Runs once per Lambda container (cold start); subsequent
 * calls are no-ops because `loaded` is kept in module scope.
 *
 * In local development APP_SECRET_ARN is absent, so the function exits early
 * and the .env file values take precedence.
 */
export async function loadSecrets(): Promise<void> {
  if (loaded) return;

  const arn = process.env.APP_SECRET_ARN;
  if (!arn) {
    logger.debug('APP_SECRET_ARN not set — skipping secret load (local dev)');
    return;
  }

  const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  const values = JSON.parse(res.SecretString ?? '{}') as Record<string, string>;

  for (const [key, value] of Object.entries(values)) {
    // Never overwrite values already set by the CDK env block or the OS
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }

  loaded = true;
  logger.debug('Secrets loaded', { arn });
}
