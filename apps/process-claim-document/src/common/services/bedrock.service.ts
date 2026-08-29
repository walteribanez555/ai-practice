import {
  ConverseCommand,
  type ContentBlock,
  type ImageFormat,
  type DocumentFormat,
} from '@aws-sdk/client-bedrock-runtime';
import { bedrockClient, BEDROCK_MODEL_ID } from '../../config/bedrock';
import { createLogger } from '../../config/logger';
import { CLAIM_EXTRACTION_TOOL, SYSTEM_PROMPT, USER_PROMPT } from '../../modules/claim/prompts';
import type { ExtractedData } from '../../modules/claim/claim.types';
import { S3Service } from './s3.service';

const logger = createLogger('BedrockService');

// ── Public types ──────────────────────────────────────────────────────────────

export interface DocumentSignals {
  lowQualityDocument:  boolean;
  possibleAlteration:  boolean;
  inconsistentParties: boolean;
}

export interface ExtractionResult {
  extracted:       ExtractedData;
  documentSignals: DocumentSignals;
}

// ── Internal tool input type ──────────────────────────────────────────────────

interface ClaimExtractionInput {
  claimType:          string | null;
  estimatedAmount:    number | null;
  incidentDate:       string | null;
  involvedParties:    string[] | null;
  descriptionSummary: string | null;
  documentSignals:    DocumentSignals;
}

// ── Content block builder ─────────────────────────────────────────────────────

const IMAGE_FORMAT_MAP: Record<string, ImageFormat> = {
  'image/jpeg': 'jpeg',
  'image/png':  'png',
  'image/gif':  'gif',
  'image/webp': 'webp',
};

const DOCUMENT_FORMAT_MAP: Record<string, DocumentFormat> = {
  'application/pdf': 'pdf',
};

function buildContentBlock(buffer: Buffer, mimeType: string): ContentBlock {
  const docFormat = DOCUMENT_FORMAT_MAP[mimeType];
  if (docFormat) {
    return {
      document: {
        format: docFormat,
        name:   'claim-document',
        source: { bytes: buffer },
      },
    };
  }

  const imgFormat = IMAGE_FORMAT_MAP[mimeType] ?? 'jpeg';
  return {
    image: {
      format: imgFormat,
      source: { bytes: buffer },
    },
  };
}

// ── Service ───────────────────────────────────────────────────────────────────

export const BedrockService = {
  async extractFromDocument(documentKey: string, contentType: string): Promise<ExtractionResult> {
    logger.info('Starting document extraction', { documentKey, contentType, model: BEDROCK_MODEL_ID });

    const { buffer } = await S3Service.getDocument(documentKey);
    const contentBlock = buildContentBlock(buffer, contentType);

    const response = await bedrockClient.send(
      new ConverseCommand({
        modelId: BEDROCK_MODEL_ID,
        system:  [{ text: SYSTEM_PROMPT }],
        messages: [{
          role:    'user',
          content: [contentBlock, { text: USER_PROMPT }],
        }],
        toolConfig: {
          tools:      [CLAIM_EXTRACTION_TOOL],
          toolChoice: { tool: { name: 'extract_claim_data' } },
        },
      }),
    );

    logger.info('Bedrock extraction complete', {
      stopReason:   response.stopReason,
      inputTokens:  response.usage?.inputTokens,
      outputTokens: response.usage?.outputTokens,
    });

    const toolBlock = response.output?.message?.content?.find(
      (b) => b.toolUse?.name === 'extract_claim_data',
    );

    if (!toolBlock?.toolUse?.input) {
      throw new Error(`Bedrock did not return a tool_use block (stopReason: ${response.stopReason})`);
    }

    const input            = toolBlock.toolUse.input as unknown as ClaimExtractionInput;
    const { documentSignals, ...fields } = input;

    return {
      extracted: {
        claimType:          fields.claimType,
        estimatedAmount:    fields.estimatedAmount,
        incidentDate:       fields.incidentDate,
        involvedParties:    fields.involvedParties,
        descriptionSummary: fields.descriptionSummary,
      },
      documentSignals,
    };
  },
};
