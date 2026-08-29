export type ClaimStatus     = 'pendiente' | 'procesando' | 'procesado' | 'error';
export type CoberturaAplica = 'si' | 'no' | 'requiere_revision';
export type Prioridad       = 'alta' | 'media' | 'baja';
export type ContentType     = 'jpeg' | 'png' | 'pdf';
export type TipoSiniestro   = 'auto' | 'salud' | 'hogar' | 'robo' | 'otro';

export const ALLOWED_CONTENT_TYPES: ContentType[] = ['jpeg', 'png', 'pdf'];

export const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024; // 15 MB

// score >= this → requiere_revision_humana = true
export const FRAUD_THRESHOLD = 60;

// monto > this → prioridad alta
export const MONTO_ALTO_THRESHOLD = 50_000;

// Fraud score weights per signal
export const FRAUD_SIGNALS = {
  FECHA_INCONSISTENTE:      20,
  MONTO_FUERA_DE_RANGO:     25,
  DOCUMENTO_BAJA_CALIDAD:   20,
  PARTES_INCONSISTENTES:    20,
  HISTORIAL_EXCEDIDO:       25,
} as const;

// Typical monto ranges by tipo_siniestro
export const MONTO_TIPICO: Record<TipoSiniestro, { min: number; max: number }> = {
  auto:  { min: 500,   max: 80_000  },
  salud: { min: 200,   max: 150_000 },
  hogar: { min: 1_000, max: 200_000 },
  robo:  { min: 100,   max: 50_000  },
  otro:  { min: 0,     max: 500_000 },
};

// How many claims in 30 days triggers the historical fraud signal
export const MAX_CLAIMS_30_DAYS = 2;

export interface ExtractedData {
  tipo_siniestro: string | null;
  monto_estimado: number | null;
  fecha_incidente: string | null; // ISO date string YYYY-MM-DD
  partes_involucradas: string[] | null;
  descripcion_resumen: string | null;
}

export interface FraudSignalResult {
  score: number;
  justificacion: string[];
}
