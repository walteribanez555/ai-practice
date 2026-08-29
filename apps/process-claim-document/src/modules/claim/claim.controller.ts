import type { Context } from 'hono';
import { ClaimService } from './claim.service';
import type { CreateClaimDto, UpdateClaimDto } from './claim.dto';
import { toAdjusterResponse, toClientResponse } from './claim.dto';
import { createLogger } from '../../config';

const logger = createLogger('ClaimController');

// Header set by the auth layer to indicate the caller's role
const ROLE_HEADER = 'x-user-role';

export const ClaimController = {

  async findAll(c: Context) {
    const claims = await ClaimService.findAll();
    return c.json(claims.map(toAdjusterResponse));
  },

  async findById(c: Context) {
    const id    = c.req.param('id') ?? '';
    const claim = await ClaimService.findById(id);
    if (!claim) return c.json({ error: 'Claim not found.' }, 404);

    const role = c.req.header(ROLE_HEADER);
    return c.json(role === 'adjuster' ? toAdjusterResponse(claim) : toClientResponse(claim));
  },

  async findByClient(c: Context) {
    const clientId = c.req.param('clientId') ?? '';
    const claims   = await ClaimService.findByClientId(clientId);
    return c.json(claims.map(toClientResponse));
  },

  async create(c: Context) {
    const body = await c.req.json<CreateClaimDto>();

    if (!body.clientId)    return c.json({ error: 'clientId is required.',    code: 'MISSING_CLIENT_ID'    }, 400);
    if (!body.documentKey) return c.json({ error: 'documentKey is required.', code: 'MISSING_DOCUMENT_KEY' }, 400);
    if (!body.contentType) return c.json({ error: 'contentType is required.', code: 'MISSING_CONTENT_TYPE' }, 400);
    if (!body.fileSizeBytes || body.fileSizeBytes <= 0) {
      return c.json({ error: 'fileSizeBytes must be greater than 0.', code: 'MISSING_FILE_SIZE' }, 400);
    }

    logger.info('Claim create', { clientId: body.clientId, contentType: body.contentType });
    const claim = await ClaimService.create(body);
    return c.json(toAdjusterResponse(claim), 201);
  },

  async process(c: Context) {
    const id = c.req.param('id') ?? '';
    logger.info('Claim process', { id });
    const claim = await ClaimService.process(id);
    return c.json(toAdjusterResponse(claim));
  },

  async update(c: Context) {
    const id    = c.req.param('id') ?? '';
    const body  = await c.req.json<UpdateClaimDto>();
    const claim = await ClaimService.update(id, body);
    return c.json(toAdjusterResponse(claim));
  },

  async delete(c: Context) {
    const id      = c.req.param('id') ?? '';
    const deleted = await ClaimService.delete(id);
    if (!deleted) return c.json({ error: 'Claim not found.' }, 404);
    return c.body(null, 204);
  },
};
