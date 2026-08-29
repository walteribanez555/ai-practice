import type { Tool } from '@aws-sdk/client-bedrock-runtime';

// ── Extraction ────────────────────────────────────────────────────────────────

export const SYSTEM_PROMPT = `You are an insurance claims specialist AI. Your task is to analyze insurance claim documents (photos or PDFs) and extract structured information accurately.

Be precise and conservative:
- Only extract information you can clearly read or infer from the document.
- Use null for any field that cannot be determined with confidence.
- For estimatedAmount, extract any monetary amount mentioned (repairs, medical bills, property value).
- For incidentDate, use YYYY-MM-DD format. If only month/year is visible, use the first day of that month.
- For claimType, classify based on the nature of the claim: auto, health, home, theft, or other.
- For documentSignals, assess document quality and integrity honestly.`;

export const USER_PROMPT =
  'Analyze this insurance claim document and extract all relevant information using the extract_claim_data tool.';

export const CLAIM_EXTRACTION_TOOL: Tool = {
  toolSpec: {
    name:        'extract_claim_data',
    description: 'Extract structured data from an insurance claim document (image or PDF).',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          claimType: {
            type:        ['string', 'null'],
            enum:        ['auto', 'health', 'home', 'theft', 'other', null],
            description: 'Type of insurance claim based on the document content.',
          },
          estimatedAmount: {
            type:        ['number', 'null'],
            description: 'Estimated monetary amount involved in USD. Null if not found.',
          },
          incidentDate: {
            type:        ['string', 'null'],
            description: 'Date of the incident in YYYY-MM-DD format. Null if not found.',
          },
          involvedParties: {
            type:        ['array', 'null'],
            items:       { type: 'string' },
            description: 'Full names of all individuals or entities mentioned in the document.',
          },
          descriptionSummary: {
            type:        ['string', 'null'],
            description: 'One or two sentence summary of the incident described in the document.',
          },
          documentSignals: {
            type:        'object',
            description: 'Quality and integrity signals used for fraud detection.',
            properties: {
              lowQualityDocument: {
                type:        'boolean',
                description: 'True if the document is blurry, dark, or otherwise hard to read.',
              },
              possibleAlteration: {
                type:        'boolean',
                description: 'True if there are visual signs of editing, inconsistent fonts, or altered content.',
              },
              inconsistentParties: {
                type:        'boolean',
                description: 'True if names or party information are contradictory across document sections.',
              },
            },
            required: ['lowQualityDocument', 'possibleAlteration', 'inconsistentParties'],
          },
        },
        required: [
          'claimType',
          'estimatedAmount',
          'incidentDate',
          'involvedParties',
          'descriptionSummary',
          'documentSignals',
        ],
      },
    },
  },
};

// ── Integrity analysis ────────────────────────────────────────────────────────

export const INTEGRITY_SYSTEM_PROMPT = `You are a document forensics specialist for an insurance company.
Analyze claim documents for signs of fraud, alteration, or poor quality.
Be objective and conservative — only flag genuine concerns, not ambiguous ones.`;

export const INTEGRITY_USER_PROMPT =
  'Assess this document for quality and integrity issues using the analyze_integrity tool.';

export const ANALYZE_INTEGRITY_TOOL: Tool = {
  toolSpec: {
    name:        'analyze_integrity',
    description: 'Assess a claim document for quality and integrity issues that may indicate fraud.',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          lowQualityDocument: {
            type:        'boolean',
            description: 'True if the document is blurry, poorly lit, or unreadable in key areas.',
          },
          possibleAlteration: {
            type:        'boolean',
            description: 'True if there are signs of editing: inconsistent fonts, pixelation around numbers or dates, misaligned text blocks.',
          },
          inconsistentParties: {
            type:        'boolean',
            description: 'True if names, ID numbers, or party information contradict each other within the document.',
          },
          observations: {
            type:        'string',
            description: 'Brief professional assessment of the document quality and any specific concerns found.',
          },
        },
        required: ['lowQualityDocument', 'possibleAlteration', 'inconsistentParties', 'observations'],
      },
    },
  },
};
