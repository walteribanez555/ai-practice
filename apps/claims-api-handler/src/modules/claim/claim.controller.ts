import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { randomUUID } from 'crypto';
import type { Context } from 'hono';
import type { AppEnv } from '../../app.types';
import { ClaimService } from './claim.service';
import type { CreateClaimDto, AddDocumentDto, UpdateClaimDto } from './claim.dto';
import { toAdjusterResponse, toClientResponse } from './claim.dto';
import { createLogger } from '../../config';
import { S3Service } from '../../common/services/s3.service';
import { ALLOWED_CONTENT_TYPES, PRESIGN_EXPIRES_IN } from '../upload/upload.types';
import { NotFoundException, BadRequestException, UnprocessableException } from '../../common/exceptions';

const sfnClient = new SFNClient({});
const SF_ARN    = process.env.CLAIM_PROCESSING_SF_ARN ?? '';
const s3        = new S3Service(process.env.DOCUMENTS_BUCKET_NAME ?? '');

const logger = createLogger('ClaimController');

export const ClaimController = {

  // ── GET /claims — adjuster only ───────────────────────────────────────────
  async findAll(c: Context<AppEnv>) {
    const claims = await ClaimService.findAll();
    return c.json(claims.map(toAdjusterResponse));
  },

  // ── GET /claims/:id — client sees own, adjuster sees all ─────────────────
  async findById(c: Context<AppEnv>) {
    const id    = c.req.param('id') ?? '';
    const claim = await ClaimService.findById(id);
    if (!claim) return c.json({ error: 'Claim not found.' }, 404);

    const role   = c.get('userRole');
    const userId = c.get('userId');

    if (role === 'client' && claim.clientId !== userId) {
      return c.json({ error: 'Forbidden.', code: 'ACCESS_DENIED' }, 403);
    }

    return c.json(role === 'adjuster' ? toAdjusterResponse(claim) : toClientResponse(claim));
  },

  // ── GET /claims/client/:clientId — client sees own, adjuster sees any ────
  async findByClient(c: Context<AppEnv>) {
    const role     = c.get('userRole');
    const userId   = c.get('userId');
    const clientId = c.req.param('clientId') ?? '';

    if (role === 'client' && clientId !== userId) {
      return c.json({ error: 'Forbidden.', code: 'ACCESS_DENIED' }, 403);
    }

    const claims = await ClaimService.findByClientId(clientId);
    return c.json(
      role === 'adjuster'
        ? claims.map(toAdjusterResponse)
        : claims.map(toClientResponse),
    );
  },

  // ── POST /claims — any authenticated user ────────────────────────────────
  async create(c: Context<AppEnv>) {
    const body   = await c.req.json<CreateClaimDto>();
    const role   = c.get('userRole');
    const userId = c.get('userId');

    const clientId = role === 'client' ? userId : (body.clientId ?? userId);
    logger.info('Claim create (draft)', { clientId });
    const claim = await ClaimService.create({ clientId, policyId: body.policyId });
    return c.json(toAdjusterResponse(claim), 201);
  },

  // ── POST /claims/:id/documents — add a document to a draft claim ─────────
  async addDocument(c: Context<AppEnv>) {
    const id   = c.req.param('id') ?? '';
    const body = await c.req.json<AddDocumentDto>();

    const claim = await ClaimService.findById(id);
    if (!claim) return c.json({ error: 'Claim not found.', code: 'CLAIM_NOT_FOUND' }, 404);
    if (claim.status !== 'draft') {
      return c.json({ error: `Cannot add documents to a claim in status "${claim.status}".`, code: 'INVALID_STATUS_TRANSITION' }, 422);
    }

    const ct = body.contentType as keyof typeof ALLOWED_CONTENT_TYPES;
    if (!ALLOWED_CONTENT_TYPES[ct]) {
      return c.json({ error: `contentType must be one of: ${Object.keys(ALLOWED_CONTENT_TYPES).join(', ')}.`, code: 'INVALID_CONTENT_TYPE' }, 400);
    }

    const mimeType    = ALLOWED_CONTENT_TYPES[ct];
    const documentKey = `documents/${randomUUID()}`;
    const uploadUrl   = await s3.getPresignedUploadUrl(documentKey, mimeType, PRESIGN_EXPIRES_IN);

    await ClaimService.appendDocument(id, { key: documentKey, contentType: ct, fileSizeBytes: body.fileSizeBytes });

    logger.info('Document slot added', { id, documentKey, ct });
    return c.json({ documentKey, uploadUrl, expiresIn: PRESIGN_EXPIRES_IN, mimeType });
  },

  // ── POST /claims/:id/submit — finalize draft and start processing ─────────
  async submit(c: Context<AppEnv>) {
    const id    = c.req.param('id') ?? '';
    const claim = await ClaimService.findById(id);
    if (!claim) return c.json({ error: 'Claim not found.', code: 'CLAIM_NOT_FOUND' }, 404);
    if (claim.status !== 'draft') {
      return c.json({ error: `Cannot submit a claim in status "${claim.status}".`, code: 'INVALID_STATUS_TRANSITION' }, 422);
    }
    if (!claim.documents?.length) {
      return c.json({ error: 'At least one document is required before submitting.', code: 'NO_DOCUMENTS' }, 422);
    }

    await ClaimService.markProcessing(id);

    logger.info('Submitting claim — starting Step Function', { id, documentCount: claim.documents.length });

    await sfnClient.send(new StartExecutionCommand({
      stateMachineArn: SF_ARN,
      name:            `claim-${id}-${Date.now()}`,
      input:           JSON.stringify({
        claimId:   claim.id,
        clientId:  claim.clientId,
        documents: claim.documents.map(d => ({ key: d.key, contentType: d.contentType, fileSizeBytes: d.fileSizeBytes })),
      }),
    }));

    return c.json({ id, status: 'processing', message: `Analysis started for ${claim.documents.length} document(s).` });
  },

  // ── POST /claims/:id/process — re-process a failed claim (adjuster only) ──
  async process(c: Context<AppEnv>) {
    const id    = c.req.param('id') ?? '';
    const claim = await ClaimService.findById(id);
    if (!claim) return c.json({ error: 'Claim not found.', code: 'CLAIM_NOT_FOUND' }, 404);

    if (claim.status !== 'pending') {
      return c.json(
        { error: `Cannot process a claim in status "${claim.status}".`, code: 'INVALID_STATUS_TRANSITION' },
        422,
      );
    }

    // Build the documents array: prefer the stored documents[], fall back to single documentKey
    const documents = claim.documents?.length
      ? claim.documents
      : [{ key: claim.documentKey, contentType: claim.contentType, fileSizeBytes: claim.fileSizeBytes }];

    await ClaimService.markProcessing(id);

    logger.info('Starting claim processing state machine', { id, documentCount: documents.length });

    await sfnClient.send(new StartExecutionCommand({
      stateMachineArn: SF_ARN,
      name:            `claim-${id}-${Date.now()}`,
      input:           JSON.stringify({
        claimId:  claim.id,
        clientId: claim.clientId,
        documents,
        // policyId omitted when undefined — Step Functions input must not contain undefined values
        ...(claim.policyId ? { policyId: claim.policyId } : {}),
      }),
    }));

    return c.json({ id, status: 'processing', message: 'Analysis started.' }, 202);
  },

  // ── PATCH /claims/:id — adjuster only ────────────────────────────────────
  async update(c: Context<AppEnv>) {
    const id    = c.req.param('id') ?? '';
    const body  = await c.req.json<UpdateClaimDto>();
    const claim = await ClaimService.update(id, body);
    return c.json(toAdjusterResponse(claim));
  },

  // ── DELETE /claims/:id — adjuster only ───────────────────────────────────
  async delete(c: Context<AppEnv>) {
    const id      = c.req.param('id') ?? '';
    const deleted = await ClaimService.delete(id);
    if (!deleted) return c.json({ error: 'Claim not found.' }, 404);
    return c.body(null, 204);
  },
};
