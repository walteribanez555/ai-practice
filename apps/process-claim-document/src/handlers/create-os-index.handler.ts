/**
 * CloudFormation Custom Resource — creates the k-NN vector index in OpenSearch Service.
 *
 * Called once on CDK deploy (CREATE) and cleaned up on destroy (DELETE).
 * The index must exist before Bedrock Knowledge Base ingests any document.
 *
 * Field mapping matches what Bedrock KB expects for OPENSEARCH_MANAGED_CLUSTER:
 *   bedrock-knowledge-base-default-vector  → knn_vector (1024 dims, Titan Embed v2)
 *   AMAZON_BEDROCK_TEXT_CHUNK              → text (the document chunk)
 *   AMAZON_BEDROCK_METADATA                → text, not indexed (source metadata)
 */

import * as https from 'https';
import * as aws4  from 'aws4';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';

const INDEX_MAPPING = {
  settings: {
    index: {
      knn:                          true,
      'knn.algo_param.ef_search':   512,
      number_of_shards:             1,
      number_of_replicas:           0,
    },
  },
  mappings: {
    properties: {
      'bedrock-knowledge-base-default-vector': {
        type:      'knn_vector',
        dimension: 1024,
        method: {
          name:       'hnsw',
          engine:     'faiss',
          space_type: 'l2',
          parameters: { ef_construction: 512, m: 16 },
        },
      },
      AMAZON_BEDROCK_TEXT_CHUNK: { type: 'text' },
      AMAZON_BEDROCK_METADATA:   { type: 'text', index: false },
    },
  },
};

// ── Signed HTTP helper ────────────────────────────────────────────────────────

function signedRequest(
  method: 'PUT' | 'DELETE' | 'HEAD',
  host: string,
  path: string,
  body?: string,
): Promise<{ status: number; body: string }> {
  const opts = aws4.sign(
    {
      host,
      path,
      method,
      service:  'es',
      region:   process.env.AWS_REGION ?? 'us-east-1',
      headers:  {
        'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': String(Buffer.byteLength(body)) } : {}),
      },
      ...(body ? { body } : {}),
    },
  );

  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: host, path, method, headers: opts.headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Custom Resource handler ───────────────────────────────────────────────────

export const handler = async (event: CloudFormationCustomResourceEvent) => {
  const host  = event.ResourceProperties['DomainEndpoint'] as string;
  const index = event.ResourceProperties['IndexName']      as string;
  const path  = `/${index}`;

  console.log(JSON.stringify({ requestType: event.RequestType, host, index }));

  if (event.RequestType === 'Delete') {
    const res = await signedRequest('DELETE', host, path);
    console.log('DELETE index', { status: res.status, body: res.body });
    return;
  }

  // CREATE or UPDATE — idempotent: skip if index already exists
  const check = await signedRequest('HEAD', host, path);
  if (check.status === 200) {
    console.log('Index already exists, skipping creation');
    return;
  }

  const body = JSON.stringify(INDEX_MAPPING);
  const res  = await signedRequest('PUT', host, path, body);

  console.log('PUT index', { status: res.status, body: res.body });

  if (res.status >= 300) {
    throw new Error(`Failed to create index "${index}": HTTP ${res.status} — ${res.body}`);
  }
};
