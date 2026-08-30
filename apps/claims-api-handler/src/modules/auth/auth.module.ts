import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';
import { UserEntity } from '../../orm/entities/user.entity';
import { authMiddleware } from './auth.middleware';
import type { LoginDto } from './auth.types';
import type { AppEnv } from '../../app.types';

export const authRouter = new Hono<AppEnv>();

authRouter.post('/login', async (c) => {
  const body = await c.req.json<LoginDto>();

  if (!body.email || !body.password) {
    return c.json({ error: 'email and password are required.', code: 'MISSING_CREDENTIALS' }, 400);
  }

  const user = await UserEntity.findByEmail(body.email.toLowerCase());

  if (!user) {
    return c.json({ error: 'Invalid credentials.', code: 'INVALID_CREDENTIALS' }, 401);
  }

  const passwordValid = await bcrypt.compare(body.password, user.passwordHash);

  if (!passwordValid) {
    return c.json({ error: 'Invalid credentials.', code: 'INVALID_CREDENTIALS' }, 401);
  }

  return c.json(AuthService.sign(user.userId, user.email, user.role), 200);
});

// POST /api/v1/auth/hipaa-acknowledge
// Records that the authenticated adjuster has completed HIPAA training.
// The dashboard must call this on first login before showing PHI claim data.
authRouter.post('/hipaa-acknowledge', authMiddleware, async (c) => {
  const email = c.get('userEmail');
  await UserEntity.acknowledgeHipaa(email);
  return c.json({ acknowledged: true, acknowledgedAt: new Date().toISOString() }, 200);
});
