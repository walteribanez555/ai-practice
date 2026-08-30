import type { Tool } from '@aws-sdk/client-bedrock-runtime';

// ─────────────────────────────────────────────────────────────────────────────
// EXTRACTION — text documents (PDF: police reports, medical bills, estimates)
// ─────────────────────────────────────────────────────────────────────────────

export const TEXT_EXTRACTION_SYSTEM_PROMPT = `You are an insurance claims specialist AI analyzing written claim documents.
These are structured text documents: accident reports, medical bills, repair estimates, invoices, or legal forms.

Rules:
- Extract only what is explicitly stated or unambiguously implied in the text.
- Use null for any field not present or unclear.
- For estimatedAmount: sum all monetary amounts if multiple items (line items in an invoice or estimate). Use USD.
- For incidentDate: use YYYY-MM-DD. If only month/year is given, use the 1st of that month.
- For claimType: classify based on document content — auto, health, home, theft, or other.
- For involvedParties: include all named individuals, companies, or license plates mentioned.
- For documentSignals.possibleAlteration: flag inconsistent fonts in key fields (amounts, dates), text that appears pasted over, or misaligned columns.
- For documentSignals.inconsistentParties: flag if the same person appears with different names or ID numbers.`;

export const TEXT_EXTRACTION_USER_PROMPT =
  'Read this document carefully and extract all relevant claim information using the extract_claim_data tool.';

// ─────────────────────────────────────────────────────────────────────────────
// EXTRACTION — visual documents (JPEG/PNG: damage photos, scene photos)
// ─────────────────────────────────────────────────────────────────────────────

export const IMAGE_EXTRACTION_SYSTEM_PROMPT = `You are an insurance claims specialist AI analyzing photographic evidence of damage or incidents.
These are photos submitted as part of an insurance claim: vehicle damage, property damage, injuries, accident scenes, etc.

Rules:
- Describe what is visually observable. Do not invent data not visible in the image.
- Use null for fields that cannot be inferred from the image alone (e.g. exact incident date unless visible).
- For claimType: determine from what is visible — auto (vehicle damage), home (property/structure), health (injuries), theft (missing property), or other.
- For estimatedAmount: only provide if repair/replacement cost is visible in the image (e.g. a price tag or document in frame). Otherwise null.
- For descriptionSummary: describe the type, location, and apparent severity of the damage visible in the image.
- For involvedParties: only include if names, license plates, or identifying information are visible in the image.
- For documentSignals.lowQualityDocument: true if the image is blurry, dark, overexposed, or the damaged area is not clearly visible.
- For documentSignals.possibleAlteration: true if there are signs of digital manipulation — inconsistent lighting/shadows, cloning artifacts, unnatural edges around damage areas, or pixelation inconsistencies.
- For documentSignals.inconsistentParties: true if visible identifiers (license plates, ID cards) appear doctored or inconsistent across multiple frames.`;

export const IMAGE_EXTRACTION_USER_PROMPT =
  'Analyze this damage photo and extract all observable claim information using the extract_claim_data tool.';

// ─────────────────────────────────────────────────────────────────────────────
// EXTRACTION — shared tool schema (same output shape for both paths)
// ─────────────────────────────────────────────────────────────────────────────

export const CLAIM_EXTRACTION_TOOL: Tool = {
  toolSpec: {
    name:        'extract_claim_data',
    description: 'Extract structured claim data from an insurance document or photo.',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          claimType: {
            type:        ['string', 'null'],
            enum:        ['auto', 'health', 'home', 'theft', 'other', null],
            description: 'Type of insurance claim.',
          },
          estimatedAmount: {
            type:        ['number', 'null'],
            description: 'Total monetary amount in USD. For invoices, sum all line items. Null if not determinable.',
          },
          incidentDate: {
            type:        ['string', 'null'],
            description: 'Date of the incident in YYYY-MM-DD format. Null if not found.',
          },
          involvedParties: {
            type:        ['array', 'null'],
            items:       { type: 'string' },
            description: 'Names, companies, or license plates of all parties involved.',
          },
          descriptionSummary: {
            type:        ['string', 'null'],
            description: 'One or two sentence summary of the incident or damage visible.',
          },
          documentSignals: {
            type: 'object',
            properties: {
              lowQualityDocument: {
                type:        'boolean',
                description: 'True if the document/image is hard to read or poorly captured.',
              },
              possibleAlteration: {
                type:        'boolean',
                description: 'True if there are signs of tampering, editing, or digital manipulation.',
              },
              inconsistentParties: {
                type:        'boolean',
                description: 'True if identifying information is contradictory within the document.',
              },
            },
            required: ['lowQualityDocument', 'possibleAlteration', 'inconsistentParties'],
          },
        },
        required: ['claimType', 'estimatedAmount', 'incidentDate', 'involvedParties', 'descriptionSummary', 'documentSignals'],
      },
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// INTEGRITY — text documents (PDFs)
// ─────────────────────────────────────────────────────────────────────────────

export const TEXT_INTEGRITY_SYSTEM_PROMPT = `You are a document forensics specialist for an insurance company.
Analyze written claim documents (PDFs, scanned forms, invoices) for signs of fraud or alteration.
Focus on text-based signals. Be objective and conservative — only flag genuine concerns.`;

export const TEXT_INTEGRITY_USER_PROMPT =
  'Assess this document for text-level quality and integrity issues using the analyze_integrity tool.';

export const TEXT_INTEGRITY_TOOL: Tool = {
  toolSpec: {
    name:        'analyze_integrity',
    description: 'Assess a written claim document for quality and integrity signals.',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          lowQualityDocument: {
            type:        'boolean',
            description: 'True if the scan is illegible, key fields are cut off, or the document is too degraded to read accurately.',
          },
          possibleAlteration: {
            type:        'boolean',
            description: 'True if there are signs of text alteration: inconsistent fonts or sizes in amounts/dates, visible whiteout or overprint, misaligned table columns, or pixelation around numeric fields.',
          },
          inconsistentParties: {
            type:        'boolean',
            description: 'True if names, ID numbers, license plates, or signatures appear contradictory or inconsistent within the document.',
          },
          observations: {
            type:        'string',
            description: 'Professional assessment noting specific text-level concerns found, or confirming the document appears authentic.',
          },
        },
        required: ['lowQualityDocument', 'possibleAlteration', 'inconsistentParties', 'observations'],
      },
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// INTEGRITY — visual documents (photos)
// ─────────────────────────────────────────────────────────────────────────────

export const IMAGE_INTEGRITY_SYSTEM_PROMPT = `You are a visual forensics specialist for an insurance company.
Analyze damage photos submitted as claim evidence for signs of staging, manipulation, or poor evidentiary quality.
Focus on image-level signals. Be objective and conservative — only flag genuine concerns.`;

export const IMAGE_INTEGRITY_USER_PROMPT =
  'Assess this photo for quality and integrity issues using the analyze_integrity tool.';

export const IMAGE_INTEGRITY_TOOL: Tool = {
  toolSpec: {
    name:        'analyze_integrity',
    description: 'Assess a damage photo for quality and visual integrity signals.',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          lowQualityDocument: {
            type:        'boolean',
            description: 'True if the image is blurry, too dark/bright, out of focus, or the damage area is not clearly visible.',
          },
          possibleAlteration: {
            type:        'boolean',
            description: 'True if there are visual signs of digital manipulation: inconsistent lighting or shadows across the image, cloning artifacts, unnaturally sharp or blurred edges around the damage area, or suspicious pixelation patterns.',
          },
          inconsistentParties: {
            type:        'boolean',
            description: 'True if visible identifiers (license plates, VIN, ID documents in frame) appear inconsistent with each other or show signs of editing.',
          },
          observations: {
            type:        'string',
            description: 'Professional assessment of the photo quality and any specific visual anomalies found, or confirmation the image appears authentic.',
          },
        },
        required: ['lowQualityDocument', 'possibleAlteration', 'inconsistentParties', 'observations'],
      },
    },
  },
};
