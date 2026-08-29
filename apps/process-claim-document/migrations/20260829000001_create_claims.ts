import type { Pool } from 'pg';
import type { Migration } from './base';

const migration: Migration = {
  id: '20260829000001_create_claims',

  async up(pool: Pool): Promise<void> {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "claims" (
        id                      UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
        status                  VARCHAR(20)   NOT NULL DEFAULT 'pendiente',

        -- Client & policy
        client_id               VARCHAR(100)  NOT NULL,
        policy_id               VARCHAR(100),

        -- Uploaded document reference
        document_key            VARCHAR(500)  NOT NULL,
        content_type            VARCHAR(10)   NOT NULL,
        file_size_bytes         BIGINT        NOT NULL,

        -- Extracted fields (null = could not be read with confidence)
        tipo_siniestro          VARCHAR(50),
        monto_estimado          NUMERIC(12,2),
        fecha_incidente         DATE,
        partes_involucradas     JSONB,
        descripcion_resumen     TEXT,

        -- Risk scoring (internal — never exposed to the client)
        score_riesgo_fraude     INTEGER       CHECK (score_riesgo_fraude BETWEEN 0 AND 100),
        justificacion_riesgo    TEXT,

        -- Coverage decision
        cobertura_aplica        VARCHAR(20)   CHECK (cobertura_aplica IN ('si','no','requiere_revision')),

        -- Routing decisions
        requiere_revision_humana BOOLEAN      NOT NULL DEFAULT FALSE,
        prioridad               VARCHAR(10)   CHECK (prioridad IN ('alta','media','baja')),

        -- Error details (populated when status = error)
        error_razon             TEXT,

        -- Timestamps
        created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        processed_at            TIMESTAMPTZ,

        CONSTRAINT claims_status_check CHECK (
          status IN ('pendiente','procesando','procesado','error')
        )
      )
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_claims_client_id  ON "claims" (client_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_claims_status      ON "claims" (status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_claims_created_at  ON "claims" (created_at DESC)`);
  },

  async down(pool: Pool): Promise<void> {
    await pool.query(`DROP TABLE IF EXISTS "claims"`);
  },
};

export default migration;
