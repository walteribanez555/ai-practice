import { Hono } from 'hono';
import { randomUUID } from 'crypto';
import { AuthService } from './auth.service';
import type { LoginDto } from './auth.types';

/**
 * Auth routes — no authentication required.
 *
 * POST /login
 *   Validates credentials and returns a signed JWT.
 *
 * NOTE: This is a simplified implementation for the MVP.
 * A production system would validate against a users table in DynamoDB.
 * The role is determined server-side (never trusted from the client).
 */
export const authRouter = new Hono();

// Hardcoded adjuster emails — in production, store roles in a users table.
const ADJUSTER_EMAILS = new Set(
  (process.env.ADJUSTER_EMAILS ?? '').split(',').map((e) => e.trim()).filter(Boolean),
);

authRouter.post('/login', async (c) => {
  const body = await c.req.json<LoginDto>();

  if (!body.email || !body.password) {
    return c.json({ error: 'email and password are required.', code: 'MISSING_CREDENTIALS' }, 400);
  }

  // TODO: validate password against hashed value in users table
  // For now any non-empty password is accepted for the MVP.

  const role    = ADJUSTER_EMAILS.has(body.email.toLowerCase()) ? 'adjuster' : 'client';
  const userId  = randomUUID(); // TODO: look up real userId from users table

  const response = AuthService.sign(userId, body.email, role);

  return c.json(response, 200);
});
