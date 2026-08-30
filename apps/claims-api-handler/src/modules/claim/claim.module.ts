import { Hono } from 'hono';
import type { AppEnv } from '../../app.types';
import { authMiddleware, requireRole } from '../auth/auth.middleware';
import { ClaimController } from './claim.controller';

export const claimRouter = new Hono<AppEnv>();

// All claim routes require a valid JWT
claimRouter.use('*', authMiddleware);

// ── Adjuster-only routes ───────────────────────────────────────────────────────
claimRouter.get('/',             requireRole('adjuster'), ClaimController.findAll);
claimRouter.post('/:id/process', requireRole('adjuster'), ClaimController.process);
claimRouter.patch('/:id',        requireRole('adjuster'), ClaimController.update);
claimRouter.delete('/:id',       requireRole('adjuster'), ClaimController.delete);

// ── Shared routes (any authenticated user) ────────────────────────────────────
claimRouter.get('/client/:clientId',    ClaimController.findByClient);
claimRouter.get('/:id',                 ClaimController.findById);
claimRouter.post('/',                   ClaimController.create);
claimRouter.post('/:id/documents',      ClaimController.addDocument);
claimRouter.post('/:id/submit',         ClaimController.submit);
claimRouter.post('/:id/decision',       requireRole('adjuster'), ClaimController.decide);
