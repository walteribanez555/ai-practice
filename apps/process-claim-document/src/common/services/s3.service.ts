import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createLogger } from '../../config/logger';

const logger = createLogger('S3Service');

const client = new S3Client({});

const bucket = (() => {
  const name = process.env.DOCUMENTS_BUCKET_NAME;
  if (!name) throw new Error('DOCUMENTS_BUCKET_NAME is not set');
  return name;
})();

export const S3Service = {
  async getDocument(key: string): Promise<{ buffer: Buffer; contentLength: number }> {
    logger.debug('Downloading document', { bucket, key });

    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));

    if (!res.Body) throw new Error(`S3 object "${key}" has no body`);

    const chunks: Uint8Array[] = [];
    for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    logger.debug('Document downloaded', { key, bytes: buffer.length });
    return { buffer, contentLength: buffer.length };
  },
};
