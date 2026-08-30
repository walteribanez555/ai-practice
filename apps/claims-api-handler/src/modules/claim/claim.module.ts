import { Hono } from 'hono';
import type { AppEnv } from '../../app.types';
import { authMiddleware, requireRole } from '../auth/auth.middleware';
import { ClaimController } from './claim.controller';

export const claimRouter = new Hono<AppEnv>();

// All claim routes require a valid JWT
claimRouter.use('*', authMiddleware);

// ── GDPR routes — must be registered before /:id to avoid param conflicts ─────
// Art. 17 — right to erasure (adjuster processes on behalf of data subject)
claimRouter.delete('/gdpr/erase/:clientId',  requireRole('adjuster'), ClaimController.gdprErase);
// Art. 20 — right to data portability (client or adjuster)
claimRouter.get('/gdpr/export/:clientId',    ClaimController.gdprExport);

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
