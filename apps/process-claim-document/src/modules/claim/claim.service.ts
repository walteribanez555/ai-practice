import { ClaimModel } from './claim.model';
import { BadRequestException, NotFoundException, UnprocessableException } from '../../common/exceptions';
import type { Claim, CreateClaimInput } from '../../orm/entities/claim.entity';
import type { FindManyOptions } from '../../orm/orm';
import type { CreateClaimDto, ProcessClaimDto, UpdateClaimDto } from './claim.dto';
import {
  ALLOWED_CONTENT_TYPES,
  FRAUD_SIGNALS,
  FRAUD_THRESHOLD,
  MAX_CLAIMS_30_DAYS,
  MAX_FILE_SIZE_BYTES,
  MONTO_ALTO_THRESHOLD,
  MONTO_TIPICO,
  type CoberturaAplica,
  type ExtractedData,
  type FraudSignalResult,
  type Prioridad,
  type TipoSiniestro,
} from './claim.types';

export const ClaimService = {

  // ── Read ──────────────────────────────────────────────────────────────────

  findAll(options?: FindManyOptions): Promise<Claim[]> {
    return ClaimModel.findAll(options);
  },

  findById(id: string): Promise<Claim | null> {
    return ClaimModel.findById(id);
  },

  findByClientId(clientId: string, options?: FindManyOptions): Promise<Claim[]> {
    return ClaimModel.findByClientId(clientId, options);
  },

  // ── Create ────────────────────────────────────────────────────────────────

  async create(dto: CreateClaimDto): Promise<Claim> {
    // Rule: content_type must be jpeg | png | pdf
    if (!ALLOWED_CONTENT_TYPES.includes(dto.contentType as never)) {
      throw new BadRequestException(
        `content_type "${dto.contentType}" no está permitido. Aceptados: ${ALLOWED_CONTENT_TYPES.join(', ')}.`,
        'INVALID_CONTENT_TYPE',
      );
    }

    // Rule: file size must not exceed 15 MB
    if (dto.fileSizeBytes > MAX_FILE_SIZE_BYTES) {
      const mb = (dto.fileSizeBytes / 1024 / 1024).toFixed(1);
      throw new BadRequestException(
        `El archivo pesa ${mb} MB y supera el límite de 15 MB.`,
        'FILE_TOO_LARGE',
      );
    }

    const input: CreateClaimInput = {
      client_id:       dto.clientId,
      document_key:    dto.documentKey,
      content_type:    dto.contentType,
      file_size_bytes: dto.fileSizeBytes,
      ...(dto.policyId ? { policy_id: dto.policyId } : {}),
    };

    return ClaimModel.create(input);
  },

  // ── Process ───────────────────────────────────────────────────────────────

  /**
   * Applies all business rules to an extracted claim document.
   * Transitions: pendiente → procesando → procesado | error
   */
  async process(id: string, dto: ProcessClaimDto): Promise<Claim> {
    const claim = await ClaimModel.findById(id);
    if (!claim) throw new NotFoundException('Reclamo no encontrado.', 'CLAIM_NOT_FOUND');

    if (claim.status !== 'pendiente') {
      throw new UnprocessableException(
        `No se puede procesar un reclamo en estado "${claim.status}".`,
        'INVALID_STATUS_TRANSITION',
      );
    }

    // Transition → procesando
    await ClaimModel.update(id, { status: 'procesando' });

    try {
      const { extracted, documentSignals = {} } = dto;

      // ── Fraud score ───────────────────────────────────────────────────────
      const recentCount = await ClaimService._countRecentClaims(claim.client_id);
      const fraud = ClaimService._computeFraudScore(
        extracted,
        documentSignals,
        recentCount,
        claim.created_at,
      );

      const requiereRevision = fraud.score >= FRAUD_THRESHOLD;

      // ── Coverage ──────────────────────────────────────────────────────────
      const coberturaAplica = ClaimService._computeCoverage(
        extracted.tipo_siniestro,
        extracted.descripcion_resumen,
      );

      // ── Priority ──────────────────────────────────────────────────────────
      const prioridad = ClaimService._computePriority(
        extracted.monto_estimado,
        fraud.score,
        requiereRevision,
      );

      // ── Persist final state ───────────────────────────────────────────────
      const updated = await ClaimModel.update(id, {
        status:                   'procesado',
        tipo_siniestro:           extracted.tipo_siniestro,
        monto_estimado:           extracted.monto_estimado,
        fecha_incidente:          extracted.fecha_incidente
                                    ? new Date(extracted.fecha_incidente)
                                    : null,
        partes_involucradas:      extracted.partes_involucradas,
        descripcion_resumen:      extracted.descripcion_resumen,
        score_riesgo_fraude:      fraud.score,
        justificacion_riesgo:     fraud.justificacion.join(' | ') || null,
        cobertura_aplica:         coberturaAplica,
        requiere_revision_humana: requiereRevision,
        prioridad,
        processed_at:             new Date(),
      });

      return updated!;
    } catch (err) {
      // Any failure during processing → error state for manual review
      const razon = err instanceof Error ? err.message : 'Error desconocido durante el procesamiento.';
      await ClaimModel.update(id, { status: 'error', error_razon: razon });
      throw err;
    }
  },

  // ── Update (adjuster edits) ───────────────────────────────────────────────

  async update(id: string, dto: UpdateClaimDto): Promise<Claim> {
    const claim = await ClaimModel.findById(id);
    if (!claim) throw new NotFoundException('Reclamo no encontrado.', 'CLAIM_NOT_FOUND');

    const updated = await ClaimModel.update(id, {
      ...(dto.tipoSiniestro      !== undefined && { tipo_siniestro:      dto.tipoSiniestro }),
      ...(dto.montoEstimado      !== undefined && { monto_estimado:      dto.montoEstimado }),
      ...(dto.fechaIncidente     !== undefined && { fecha_incidente:     new Date(dto.fechaIncidente) }),
      ...(dto.partesInvolucradas !== undefined && { partes_involucradas: dto.partesInvolucradas }),
      ...(dto.descripcionResumen !== undefined && { descripcion_resumen: dto.descripcionResumen }),
      ...(dto.coberturaAplica    !== undefined && { cobertura_aplica:    dto.coberturaAplica }),
    });

    return updated!;
  },

  // ── Delete ────────────────────────────────────────────────────────────────

  delete(id: string): Promise<boolean> {
    return ClaimModel.delete(id);
  },

  // ── Business logic (pure functions) ───────────────────────────────────────

  _computeFraudScore(
    extracted: ExtractedData,
    documentSignals: ProcessClaimDto['documentSignals'],
    recentClaimCount: number,
    claimCreatedAt: Date,
  ): FraudSignalResult {
    let score = 0;
    const justificacion: string[] = [];

    // Signal: fecha_incidente inconsistente con la fecha del documento
    if (extracted.fecha_incidente) {
      const incidente = new Date(extracted.fecha_incidente);
      const diffDays  = Math.abs(
        (claimCreatedAt.getTime() - incidente.getTime()) / (1000 * 60 * 60 * 24),
      );
      // > 365 días de diferencia entre el incidente y la apertura del reclamo
      if (diffDays > 365) {
        score += FRAUD_SIGNALS.FECHA_INCONSISTENTE;
        justificacion.push(
          `Fecha del incidente con más de ${Math.round(diffDays)} días de diferencia respecto al reclamo.`,
        );
      }
    }

    // Signal: monto fuera del rango típico para el tipo_siniestro
    if (extracted.monto_estimado !== null && extracted.tipo_siniestro) {
      const tipo = extracted.tipo_siniestro as TipoSiniestro;
      const rango = MONTO_TIPICO[tipo] ?? MONTO_TIPICO.otro;
      if (
        extracted.monto_estimado < rango.min ||
        extracted.monto_estimado > rango.max
      ) {
        score += FRAUD_SIGNALS.MONTO_FUERA_DE_RANGO;
        justificacion.push(
          `Monto $${extracted.monto_estimado} fuera del rango típico [$${rango.min}–$${rango.max}] para "${tipo}".`,
        );
      }
    }

    // Signal: documento de baja calidad o posible alteración
    if (documentSignals?.bajaCalidadDocumento || documentSignals?.posibleAlteracion) {
      score += FRAUD_SIGNALS.DOCUMENTO_BAJA_CALIDAD;
      justificacion.push('Documento de baja calidad o posible alteración detectada.');
    }

    // Signal: partes involucradas inconsistentes
    if (documentSignals?.partesInconsistentes) {
      score += FRAUD_SIGNALS.PARTES_INCONSISTENTES;
      justificacion.push('Partes involucradas con inconsistencias entre secciones del documento.');
    }

    // Signal: mismo cliente con >MAX_CLAIMS_30_DAYS reclamos en últimos 30 días
    if (recentClaimCount > MAX_CLAIMS_30_DAYS) {
      score += FRAUD_SIGNALS.HISTORIAL_EXCEDIDO;
      justificacion.push(
        `Cliente con ${recentClaimCount} reclamos en los últimos 30 días (límite: ${MAX_CLAIMS_30_DAYS}).`,
      );
    }

    return { score: Math.min(score, 100), justificacion };
  },

  /**
   * Rule: ante la duda, SIEMPRE 'requiere_revision'.
   * Never confirms coverage without explicit policy backing.
   */
  _computeCoverage(
    tipoSiniestro: string | null,
    descripcion: string | null,
  ): CoberturaAplica {
    // Without extracted tipo or description, the coverage cannot be determined.
    if (!tipoSiniestro || !descripcion) return 'requiere_revision';

    // Placeholder: real implementation receives the policy text and applies
    // NLP/AI matching. Until then, default conservatively to requiere_revision.
    return 'requiere_revision';
  },

  _computePriority(
    montoEstimado: number | null,
    scoreFraude: number,
    requiereRevision: boolean,
  ): Prioridad {
    if (requiereRevision || (montoEstimado !== null && montoEstimado > MONTO_ALTO_THRESHOLD)) {
      return 'alta';
    }
    if (scoreFraude >= 30 && scoreFraude < FRAUD_THRESHOLD) {
      return 'media';
    }
    return 'baja';
  },

  async _countRecentClaims(clientId: string): Promise<number> {
    const since = new Date();
    since.setDate(since.getDate() - 30);
    const recent = await ClaimModel.findRecentByClientId(clientId, since);
    return recent.length;
  },
};
