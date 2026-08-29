import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BaseService } from './base.service';

export class S3Service extends BaseService {
  private readonly client: S3Client;

  constructor(private readonly bucket: string) {
    super('S3Service');
    // Disable automatic checksum injection so presigned PUT URLs work from
    // the browser — fetch() cannot compute CRC32 before sending the body.
    this.client = new S3Client({
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  /**
   * Generate a presigned PUT URL for direct browser-to-S3 upload.
   * S3 enforces the ContentType set here — the client MUST send the same
   * Content-Type header during the PUT, otherwise S3 returns 403.
   */
  async getPresignedUploadUrl(key: string, mimeType: string, expiresIn = 300): Promise<string> {
    const command = new PutObjectCommand({
      Bucket:      this.bucket,
      Key:         key,
      ContentType: mimeType,
    });
    const url = await getSignedUrl(this.client, command, { expiresIn });
    this.logger.debug('Presigned upload URL generated', { key, mimeType, expiresIn });
    return url;
  }

  async headObject(key: string): Promise<{ mimeType: string; size: number }> {
    const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
    return {
      mimeType: res.ContentType ?? 'application/octet-stream',
      size:     res.ContentLength ?? 0,
    };
  }

  getObjectUri(key: string): string {
    return `s3://${this.bucket}/${key}`;
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    this.logger.debug('Object deleted', { key });
  }
}
