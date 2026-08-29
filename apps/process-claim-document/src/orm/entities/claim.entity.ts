import { db } from '../../config/db';
import type { FindManyOptions } from '../orm';
import type { ClaimStatus, CoberturaAplica, Prioridad } from '../../modules/claim/claim.types';

export interface Claim extends Record<string, unknown> {
  id: string;
  status: ClaimStatus;
  client_id: string;
  policy_id: string | null;
  document_key: string;
  content_type: string;
  file_size_bytes: number;
  // Extracted — null means the field couldn't be read from the document
  tipo_siniestro: string | null;
  monto_estimado: number | null;
  fecha_incidente: Date | null;
  partes_involucradas: string[] | null;
  descripcion_resumen: string | null;
  // Risk scoring (internal — never exposed to the client)
  score_riesgo_fraude: number | null;
  justificacion_riesgo: string | null;
  // Coverage decision
  cobertura_aplica: CoberturaAplica | null;
  // Decisions
  requiere_revision_humana: boolean;
  prioridad: Prioridad | null;
  // Error details (populated when status = 'error')
  error_razon: string | null;
  // Timestamps
  created_at: Date;
  updated_at: Date;
  processed_at: Date | null;
}

export type CreateClaimInput = Pick<
  Claim,
  'client_id' | 'document_key' | 'content_type' | 'file_size_bytes'
> & Partial<Pick<Claim, 'policy_id'>>;

export type UpdateClaimInput = Partial<
  Pick<
    Claim,
    | 'status'
    | 'tipo_siniestro'
    | 'monto_estimado'
    | 'fecha_incidente'
    | 'partes_involucradas'
    | 'descripcion_resumen'
    | 'score_riesgo_fraude'
    | 'justificacion_riesgo'
    | 'cobertura_aplica'
    | 'requiere_revision_humana'
    | 'prioridad'
    | 'error_razon'
    | 'processed_at'
  >
>;

const table = db.table<Claim>('claims');

export const ClaimEntity = {
  findAll(options?: FindManyOptions) {
    return table.findMany(options);
  },

  findById(id: string) {
    return table.findOne({ where: { id } });
  },

  findByClientId(clientId: string, options?: FindManyOptions) {
    return table.findMany({ ...options, where: { ...options?.where, client_id: clientId } });
  },

  findRecentByClientId(clientId: string, sinceDate: Date) {
    return db.query<Claim>(
      `SELECT * FROM "claims"
       WHERE client_id = $1
         AND created_at >= $2
         AND status != 'error'`,
      [clientId, sinceDate],
    );
  },

  create(input: CreateClaimInput) {
    return table.create({ ...input, status: 'pendiente' });
  },

  update(id: string, input: UpdateClaimInput) {
    return table.update({ where: { id }, data: { ...input, updated_at: new Date() } });
  },

  delete(id: string) {
    return table.delete({ where: { id } });
  },
};
