/**
 * S3 trigger — fired on ObjectCreated in the documents bucket.
 *
 * Looks up the claim by documentKey (GSI), marks it processing,
 * and starts the Step Function execution.
 */
import type { S3Event } from 'aws-lambda';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const sfn    = new SFNClient({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE  = process.env.CLAIMS_TABLE_NAME   ?? '';
const SF_ARN = process.env.CLAIM_PROCESSING_SF_ARN ?? '';

export const handler = async (event: S3Event): Promise<void> => {
  for (const record of event.Records) {
    const documentKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

    // Find claim by documentKey via GSI
    const result = await dynamo.send(new QueryCommand({
      TableName:                 TABLE,
      IndexName:                 'documentKey-index',
      KeyConditionExpression:    'documentKey = :k',
      ExpressionAttributeValues: { ':k': documentKey },
      Limit:                     1,
    }));

    const claim = result.Items?.[0];
    if (!claim) {
      console.warn('s3-trigger: no claim found for key', documentKey);
      continue;
    }

    if (claim.status !== 'pending') {
      console.log(`s3-trigger: claim ${claim.id} is ${claim.status}, skipping`);
      continue;
    }

    // Mark processing
    await dynamo.send(new UpdateCommand({
      TableName:                 TABLE,
      Key:                       { id: claim.id },
      UpdateExpression:          'SET #s = :s, updatedAt = :u',
      ExpressionAttributeNames:  { '#s': 'status' },
      ExpressionAttributeValues: { ':s': 'processing', ':u': new Date().toISOString() },
    }));

    // Start Step Function
    await sfn.send(new StartExecutionCommand({
      stateMachineArn: SF_ARN,
      name:            `claim-${claim.id}-${Date.now()}`,
      input:           JSON.stringify({
        claimId:   claim.id,
        clientId:  claim.clientId,
        documents: [{ key: documentKey, contentType: claim.contentType, fileSizeBytes: claim.fileSizeBytes }],
      }),
    }));

    console.log(`s3-trigger: started processing for claim ${claim.id}`);
  }
};
