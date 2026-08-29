import jwt from 'jsonwebtoken';
import type { JwtPayload, AuthResponseDto } from './auth.types';
import type { UserRole } from '../../app.types';
import { createLogger } from '../../config';

const logger = createLogger('AuthService');

const TOKEN_EXPIRES_IN = 60 * 60 * 8; // 8 hours

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set');
  return secret;
}

export const AuthService = {

  /**
   * Issues a signed JWT for the given user.
   * In production, validate credentials against a users table before calling this.
   */
  sign(userId: string, email: string, role: UserRole): AuthResponseDto {
    const payload: Omit<JwtPayload, 'iat' | 'exp'> = { sub: userId, email, role };

    const token = jwt.sign(payload, getSecret(), { expiresIn: TOKEN_EXPIRES_IN });

    logger.info('Token issued', { userId, role });

    return { token, expiresIn: TOKEN_EXPIRES_IN, userId, role };
  },

  /**
   * Verifies a JWT and returns its payload, or null if invalid/expired.
   */
  verify(token: string): JwtPayload | null {
    try {
      return jwt.verify(token, getSecret()) as JwtPayload;
    } catch {
      return null;
    }
  },
};
