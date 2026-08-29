import { randomUUID } from 'crypto';
import type { Context } from 'hono';
import type { AppEnv } from '../../app.types';
import { BadRequestException, handleException } from '../../common/exceptions';
import { S3Service } from '../../common/services/s3.service';
import {
  ALLOWED_CONTENT_TYPES,
  PRESIGN_EXPIRES_IN,
  type AllowedContentType,
  type PresignRequestDto,
  type PresignResponseDto,
} from './upload.types';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`${name} is not set`);
  return val;
}

const storage = new S3Service(requireEnv('DOCUMENTS_BUCKET_NAME'));

export const UploadController = {

  /**
   * POST /upload/presign
   *
   * Returns a presigned S3 PUT URL valid for 5 minutes.
   * The client uploads the file directly to S3, then passes documentKey
   * to POST /claims to create the claim record.
   *
   * Flow:
   *   1. POST /upload/presign { contentType: 'jpeg' | 'png' | 'pdf' }
   *   2. PUT {uploadUrl}  (file bytes, Content-Type header must match)
   *   3. POST /claims { documentKey, contentType, fileSizeBytes, ... }
   */
  async presign(c: Context<AppEnv>): Promise<Response> {
    try {
      const body = await c.req.json<PresignRequestDto>();

      if (!body.contentType || !(body.contentType in ALLOWED_CONTENT_TYPES)) {
        throw new BadRequestException(
          `contentType must be one of: ${Object.keys(ALLOWED_CONTENT_TYPES).join(', ')}.`,
          'INVALID_CONTENT_TYPE',
        );
      }

      const mimeType    = ALLOWED_CONTENT_TYPES[body.contentType as AllowedContentType];
      const sessionId   = randomUUID();
      const documentKey = `documents/${sessionId}`;

      const uploadUrl = await storage.getPresignedUploadUrl(documentKey, mimeType, PRESIGN_EXPIRES_IN);

      const response: PresignResponseDto = {
        documentKey,
        uploadUrl,
        expiresIn: PRESIGN_EXPIRES_IN,
        mimeType,
      };

      return c.json(response, 200);
    } catch (err) {
      return handleException(err, c);
    }
  },
};
