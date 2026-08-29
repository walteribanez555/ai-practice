import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createLogger } from './logger';

const logger = createLogger('DynamoDB');

const rawClient = new DynamoDBClient({});

export const docClient = DynamoDBDocumentClient.from(rawClient, {
  marshallOptions: {
    removeUndefinedValues: true, // never store undefined as DynamoDB NULL
    convertEmptyValues: false,
  },
  unmarshallOptions: {
    wrapNumbers: false,
  },
});

const tableName = process.env.CLAIMS_TABLE_NAME;
if (!tableName) throw new Error('CLAIMS_TABLE_NAME is not set');

export const CLAIMS_TABLE = tableName;

logger.debug('DynamoDB client initialized', { table: CLAIMS_TABLE });
