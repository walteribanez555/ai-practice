/**
 * Step Functions handler — check client claim history.
 *
 * Input:  { claimId, clientId }
 * Output: HistoryResult — recent claim count + fraud flag
 *
 * Flags the client if they have more than MAX_RECENT_CLAIMS in the last 30 days.
 * High claim frequency is a known fraud signal in insurance.
 */

import type { Handler } from 'aws-lambda';
import { ClaimEntity } from '../orm/entities/claim.entity';
import { createLogger } from '../config/logger';
import type { CheckHistoryInput, HistoryResult } from './sf.types';

const logger = createLogger('CheckHistory');

const MAX_RECENT_CLAIMS = 2;
const WINDOW_DAYS       = 30;

export const handler: Handler<CheckHistoryInput, HistoryResult> = async (event) => {
  const { claimId, clientId } = event;
  logger.info('Checking client history', { claimId, clientId });

  const since = new Date();
  since.setDate(since.getDate() - WINDOW_DAYS);

  const recentClaims = await ClaimEntity.findRecentByClientId(clientId, since);

  // Exclude the current claim from the count
  const otherClaims     = recentClaims.filter((c) => c.id !== claimId);
  const recentClaimCount = otherClaims.length;
  const flagged          = recentClaimCount > MAX_RECENT_CLAIMS;

  logger.info('History checked', { claimId, clientId, recentClaimCount, flagged });

  return { recentClaimCount, flagged };
};
