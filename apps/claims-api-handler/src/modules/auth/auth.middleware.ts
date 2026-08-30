import { createMiddleware } from 'hono/factory';
import type { AppEnv, UserRole } from '../../app.types';
import { AuthService } from './auth.service';

/**
 * Validates the Bearer token and attaches userId + userRole to context.
 * Apply to any route that requires authentication.
 */
export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized.', code: 'MISSING_TOKEN' }, 401);
  }

  const payload = AuthService.verify(authHeader.slice(7));

  if (!payload) {
    return c.json({ error: 'Unauthorized.', code: 'INVALID_TOKEN' }, 401);
  }

  c.set('userId',    payload.sub);
  c.set('userRole',  payload.role);
  c.set('userEmail', payload.email);

  return next();
});

/**
 * Restricts a route to a specific role.
 * Must be applied AFTER authMiddleware.
 */
export const requireRole = (role: UserRole) =>
  createMiddleware<AppEnv>(async (c, next) => {
    if (c.get('userRole') !== role) {
      return c.json({ error: 'Forbidden.', code: 'INSUFFICIENT_ROLE' }, 403);
    }
    return next();
  });
