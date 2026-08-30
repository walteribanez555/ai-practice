import {
  ConverseCommand,
  type ContentBlock,
  type DocumentFormat,
  type GuardrailConfiguration,
  type ImageFormat,
  type Tool,
} from '@aws-sdk/client-bedrock-runtime';
import { bedrockClient, BEDROCK_MODEL_ID, GUARDRAIL_ID, GUARDRAIL_VERSION } from '../../config/bedrock';
import { createLogger } from '../../config/logger';
import {
  CLAIM_EXTRACTION_TOOL,
  TEXT_EXTRACTION_SYSTEM_PROMPT,
  TEXT_EXTRACTION_USER_PROMPT,
  IMAGE_EXTRACTION_SYSTEM_PROMPT,
  IMAGE_EXTRACTION_USER_PROMPT,
  TEXT_INTEGRITY_SYSTEM_PROMPT,
  TEXT_INTEGRITY_USER_PROMPT,
  TEXT_INTEGRITY_TOOL,
  IMAGE_INTEGRITY_SYSTEM_PROMPT,
  IMAGE_INTEGRITY_USER_PROMPT,
  IMAGE_INTEGRITY_TOOL,
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

// ── Content type helpers ──────────────────────────────────────────────────────

const IMAGE_FORMAT_MAP: Record<string, ImageFormat> = {
  'image/jpeg': 'jpeg', 'jpeg': 'jpeg',
  'image/png':  'png',  'png':  'png',
  'image/gif':  'gif',  'gif':  'gif',
  'image/webp': 'webp', 'webp': 'webp',
};

const DOCUMENT_FORMAT_MAP: Record<string, DocumentFormat> = {
  'application/pdf': 'pdf',
  'pdf':             'pdf',
};

function isImageType(contentType: string): boolean {
  return contentType in IMAGE_FORMAT_MAP;
}

function buildContentBlock(buffer: Buffer, contentType: string): ContentBlock {
  const docFormat = DOCUMENT_FORMAT_MAP[contentType];
  if (docFormat) {
    return { document: { format: docFormat, name: 'claim-document', source: { bytes: buffer } } };
  }
  return { image: { format: IMAGE_FORMAT_MAP[contentType] ?? 'jpeg', source: { bytes: buffer } } };
}

// ── Core invocation helper ────────────────────────────────────────────────────

const guardrailConfig: GuardrailConfiguration | undefined = GUARDRAIL_ID
  ? { guardrailIdentifier: GUARDRAIL_ID, guardrailVersion: GUARDRAIL_VERSION, trace: 'enabled' }
  : undefined;

async function invokeWithTool<T>(
  buffer:       Buffer,
  contentType:  string,
  systemPrompt: string,
  userPrompt:   string,
  tool:         Tool,
  toolName:     string,
): Promise<T> {
  const contentBlock = buildContentBlock(buffer, contentType);

  const response = await bedrockClient.send(new ConverseCommand({
    modelId: BEDROCK_MODEL_ID,
    system:  [{ text: systemPrompt }],
    messages: [{ role: 'user', content: [contentBlock, { text: userPrompt }] }],
    toolConfig:     { tools: [tool], toolChoice: { tool: { name: toolName } } },
    guardrailConfig,
  }));

  const toolBlock = response.output?.message?.content?.find(b => b.toolUse?.name === toolName);
  if (!toolBlock?.toolUse?.input) {
    throw new Error(`Bedrock did not return "${toolName}" block (stopReason: ${response.stopReason})`);
  }
  return toolBlock.toolUse.input as unknown as T;
}

// ── Service ───────────────────────────────────────────────────────────────────

export const BedrockService = {

  async extractFromDocument(documentKey: string, contentType: string): Promise<ExtractionResult> {
    const isImage = isImageType(contentType);
    logger.info('Extracting structured data', { documentKey, contentType, mode: isImage ? 'image' : 'text' });

    const { buffer } = await S3Service.getDocument(documentKey);

    const systemPrompt = isImage ? IMAGE_EXTRACTION_SYSTEM_PROMPT : TEXT_EXTRACTION_SYSTEM_PROMPT;
    const userPrompt   = isImage ? IMAGE_EXTRACTION_USER_PROMPT   : TEXT_EXTRACTION_USER_PROMPT;

    const input = await invokeWithTool<ClaimExtractionInput>(
      buffer, contentType,
      systemPrompt, userPrompt,
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
    const isImage = isImageType(contentType);
    logger.info('Analyzing document integrity', { documentKey, contentType, mode: isImage ? 'image' : 'text' });

    const { buffer } = await S3Service.getDocument(documentKey);

    const systemPrompt = isImage ? IMAGE_INTEGRITY_SYSTEM_PROMPT : TEXT_INTEGRITY_SYSTEM_PROMPT;
    const userPrompt   = isImage ? IMAGE_INTEGRITY_USER_PROMPT   : TEXT_INTEGRITY_USER_PROMPT;
    const tool         = isImage ? IMAGE_INTEGRITY_TOOL           : TEXT_INTEGRITY_TOOL;

    return invokeWithTool<IntegrityAnalysis>(
      buffer, contentType,
      systemPrompt, userPrompt,
      tool, 'analyze_integrity',
    );
  },
};
