import { Hono } from 'hono';
import { ClaimController } from './claim.controller';

export const claimRouter = new Hono();

claimRouter.get('/',                     ClaimController.findAll);
claimRouter.get('/client/:clientId',     ClaimController.findByClient);
claimRouter.get('/:id',                  ClaimController.findById);
claimRouter.post('/',                    ClaimController.create);
claimRouter.post('/:id/process',         ClaimController.process);
claimRouter.patch('/:id',               ClaimController.update);
claimRouter.delete('/:id',              ClaimController.delete);
