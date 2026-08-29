import type { Claim } from '../../orm/entities/claim.entity';
import type { ClaimStatus, CoberturaAplica, ExtractedData, Prioridad } from './claim.types';

// ── Input DTOs ────────────────────────────────────────────────────────────────

export interface CreateClaimDto {
  clientId: string;
  policyId?: string;
  documentKey: string;
  contentType: string;
  fileSizeBytes: number;
}

export interface ProcessClaimDto {
  extracted: ExtractedData;
  /** Signals raised by the document analysis (e.g. low_quality, possible_alteration) */
  documentSignals?: {
    bajaCalidadDocumento?: boolean;
    posibleAlteracion?: boolean;
    partesInconsistentes?: boolean;
  };
}

export interface UpdateClaimDto {
  tipoSiniestro?: string;
  montoEstimado?: number;
  fechaIncidente?: string;
  partesInvolucradas?: string[];
  descripcionResumen?: string;
  coberturaAplica?: CoberturaAplica;
}

// ── Response DTOs ─────────────────────────────────────────────────────────────

/** What the end client sees — no internal risk data. */
export interface ClaimClientResponseDto {
  id: string;
  status: ClaimStatus;
  tipoSiniestro: string | null;
  montoEstimado: number | null;
  fechaIncidente: string | null;
  descripcionResumen: string | null;
  coberturaAplica: CoberturaAplica | null;
  createdAt: Date;
  updatedAt: Date;
  processedAt: Date | null;
}

/** What the adjuster sees — includes internal risk data. */
export interface ClaimAdjusterResponseDto extends ClaimClientResponseDto {
  clientId: string;
  policyId: string | null;
  partesInvolucradas: string[] | null;
  scoreRiesgoFraude: number | null;
  justificacionRiesgo: string | null;
  requiereRevisionHumana: boolean;
  prioridad: Prioridad | null;
  errorRazon: string | null;
}

// ── Mappers ───────────────────────────────────────────────────────────────────

export const toClientResponse = (c: Claim): ClaimClientResponseDto => ({
  id: c.id,
  status: c.status,
  tipoSiniestro: c.tipo_siniestro,
  montoEstimado: c.monto_estimado,
  fechaIncidente: c.fecha_incidente ? new Date(c.fecha_incidente).toISOString().slice(0, 10) : null,
  descripcionResumen: c.descripcion_resumen,
  coberturaAplica: c.cobertura_aplica,
  createdAt: c.created_at,
  updatedAt: c.updated_at,
  processedAt: c.processed_at,
});

export const toAdjusterResponse = (c: Claim): ClaimAdjusterResponseDto => ({
  ...toClientResponse(c),
  clientId: c.client_id,
  policyId: c.policy_id,
  partesInvolucradas: c.partes_involucradas,
  scoreRiesgoFraude: c.score_riesgo_fraude,
  justificacionRiesgo: c.justificacion_riesgo,
  requiereRevisionHumana: c.requiere_revision_humana,
  prioridad: c.prioridad,
  errorRazon: c.error_razon,
});
