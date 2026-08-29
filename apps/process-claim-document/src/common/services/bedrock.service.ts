import {
  ConverseCommand,
  type ContentBlock,
  type DocumentFormat,
  type ImageFormat,
  type Tool,
} from '@aws-sdk/client-bedrock-runtime';
import { bedrockClient, BEDROCK_MODEL_ID } from '../../config/bedrock';
import { createLogger } from '../../config/logger';
import {
  ANALYZE_INTEGRITY_TOOL,
  CLAIM_EXTRACTION_TOOL,
  INTEGRITY_SYSTEM_PROMPT,
  INTEGRITY_USER_PROMPT,
  SYSTEM_PROMPT,
  USER_PROMPT,
} from '../../modules/claim/prompts';
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

// ── Public integrity type ─────────────────────────────────────────────────────

export interface IntegrityAnalysis {
  lowQualityDocument:  boolean;
  possibleAlteration:  boolean;
  inconsistentParties: boolean;
  observations:        string;
}

// ── Internal tool input types ─────────────────────────────────────────────────

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

// ── Shared helper ─────────────────────────────────────────────────────────────

async function invokeWithTool<T>(
  buffer:     Buffer,
  mimeType:   string,
  systemPrompt: string,
  userPrompt:   string,
  tool:         Tool,
  toolName:     string,
): Promise<T> {
  const contentBlock = buildContentBlock(buffer, mimeType);

  const response = await bedrockClient.send(
    new ConverseCommand({
      modelId: BEDROCK_MODEL_ID,
      system:  [{ text: systemPrompt }],
      messages: [{ role: 'user', content: [contentBlock, { text: userPrompt }] }],
      toolConfig: {
        tools:      [tool],
        toolChoice: { tool: { name: toolName } },
      },
    }),
  );

  const toolBlock = response.output?.message?.content?.find(
    (b) => b.toolUse?.name === toolName,
  );
  if (!toolBlock?.toolUse?.input) {
    throw new Error(`Bedrock did not return "${toolName}" block (stopReason: ${response.stopReason})`);
  }
  return toolBlock.toolUse.input as unknown as T;
}

// ── Service ───────────────────────────────────────────────────────────────────

export const BedrockService = {
  async extractFromDocument(documentKey: string, contentType: string): Promise<ExtractionResult> {
    logger.info('Extracting structured data', { documentKey, contentType });

    const { buffer } = await S3Service.getDocument(documentKey);
    const input = await invokeWithTool<ClaimExtractionInput>(
      buffer, contentType,
      SYSTEM_PROMPT, USER_PROMPT,
      CLAIM_EXTRACTION_TOOL, 'extract_claim_data',
    );

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

  async analyzeIntegrity(documentKey: string, contentType: string): Promise<IntegrityAnalysis> {
    logger.info('Analyzing document integrity', { documentKey, contentType });

    const { buffer } = await S3Service.getDocument(documentKey);
    return invokeWithTool<IntegrityAnalysis>(
      buffer, contentType,
      INTEGRITY_SYSTEM_PROMPT, INTEGRITY_USER_PROMPT,
      ANALYZE_INTEGRITY_TOOL, 'analyze_integrity',
    );
  },
};
