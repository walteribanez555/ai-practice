import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';
import { UserEntity } from '../../orm/entities/user.entity';
import type { LoginDto } from './auth.types';

export const authRouter = new Hono();

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
