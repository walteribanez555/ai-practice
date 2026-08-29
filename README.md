# Sistema de Gestión de Reclamos con IA — AWS Bedrock

Sistema serverless en AWS que automatiza la primera etapa del procesamiento de reclamos de seguros. Usa Amazon Bedrock (Nova Pro) para analizar documentos, detectar fraude y consultar cobertura de pólizas.

---

## Arquitectura general

```
Cliente/Frontend
     │
     ├── POST /upload/presign ──► Lambda: claims-api-handler ──► S3 presigned URL
     │
     ├── PUT {presignedUrl} ─────► S3 (subida directa, sin pasar por Lambda)
     │
     ├── POST /claims ───────────► Lambda: claims-api-handler ──► DynamoDB (status: pending)
     │
     └── POST /claims/:id/process ► Lambda: claims-api-handler ──► Step Functions (202)
                                                                          │
                                        ┌─────────────────────────────────┤
                                        │        Parallel (top-level)     │
                                        │                                 │
                                        │  Map(documents)  check-history  check-coverage
                                        │  ─────────────   ───────────── ──────────────
                                        │  Por cada doc:   DynamoDB       Bedrock KB
                                        │  ┌────────────┐  (30 días)     (stub)
                                        │  │extract-data│
                                        │  │ (Bedrock)  │
                                        │  ├────────────┤
                                        │  │ analyze-   │
                                        │  │ integrity  │
                                        │  │ (Bedrock)  │
                                        │  └────────────┘
                                        │
                                        └──► aggregate-risk ──► DynamoDB (status: processed)

GET /claims/:id ──────────────────────► Lambda: claims-api-handler ──► DynamoDB
```

---

## Servicios AWS

| Servicio | Rol |
|---|---|
| **Amazon S3** | Almacena documentos de siniestros (fotos/PDFs). Subida directa vía presigned URL |
| **AWS Lambda** | `claims-api-handler` (API REST) + 5 handlers del pipeline de IA |
| **API Gateway** | Expone los endpoints HTTP |
| **Amazon Bedrock (Nova Pro)** | Extracción estructurada + análisis forense de documentos |
| **Step Functions** | Orquesta el análisis paralelo multi-documento |
| **Amazon DynamoDB** | Almacena reclamos con resultados de IA y score de fraude |
| **AWS IAM** | Roles de mínimo privilegio por función |
| **AWS KMS** | Cifrado en reposo (S3 y DynamoDB) |
| **AWS CDK** | Infraestructura como código |

---

## Flujo de negocio

### 1. Subida de documentos

El cliente solicita una presigned URL por cada documento:

```
POST /upload/presign
{ "contentType": "jpeg" | "png" | "pdf" }

→ 200 { documentKey, uploadUrl, mimeType, expiresIn: 300 }
```

Luego sube cada archivo directamente a S3 con `PUT {uploadUrl}`. Esto evita el límite de 10 MB de API Gateway y reduce carga en Lambda.

### 2. Creación del reclamo

```
POST /claims
{
  "clientId": "uuid",
  "policyId": "opcional",
  "documents": [
    { "key": "documents/uuid-1", "contentType": "image/jpeg", "fileSizeBytes": 204800 },
    { "key": "documents/uuid-2", "contentType": "application/pdf", "fileSizeBytes": 512000 }
  ]
}

→ 201 { id, status: "pending", ... }
```

El reclamo se guarda en DynamoDB con `status: "pending"`. Aún no se llama a Bedrock.

### 3. Disparo del análisis

```
POST /claims/:id/process

→ 202 { id, status: "processing", message: "Analysis started." }
```

El handler marca el reclamo como `processing` y lanza la ejecución de Step Functions de forma **asíncrona**. El cliente recibe 202 de inmediato.

### 4. Análisis paralelo (Step Functions)

Step Functions ejecuta tres ramas en paralelo:

#### Rama A — análisis por documento (Map)

Por cada documento del reclamo se ejecutan **dos Lambdas en paralelo**:

**`extract-data`** — extrae los campos estructurados del documento vía Bedrock:

| Campo | Descripción |
|---|---|
| `claimType` | `auto` / `health` / `home` / `theft` / `other` |
| `estimatedAmount` | Monto en USD mencionado en el documento |
| `incidentDate` | Fecha del incidente (YYYY-MM-DD) |
| `involvedParties` | Nombres de todas las partes involucradas |
| `descriptionSummary` | Resumen del incidente en 1–2 oraciones |

**`analyze-integrity`** — evalúa señales forenses del documento vía Bedrock:

| Campo | Descripción |
|---|---|
| `lowQualityDocument` | Documento borroso, oscuro o ilegible en zonas clave |
| `possibleAlteration` | Fuentes inconsistentes, pixelación alrededor de números/fechas |
| `inconsistentParties` | Información contradictoria de personas dentro del mismo doc |
| `integrityScore` | Score 0–100 (0 = limpio, 100 = muy sospechoso) |

#### Rama B — historial del cliente (`check-history`)

Consulta DynamoDB para los reclamos del mismo `clientId` en los últimos 30 días:

| Campo | Descripción |
|---|---|
| `recentClaimCount` | Cantidad de reclamos recientes (excluye el actual) |
| `flagged` | `true` si supera el límite (> 2 reclamos en 30 días) |

#### Rama C — cobertura de póliza (`check-coverage`)

Stub activo — consultará la Bedrock Knowledge Base (OpenSearch Serverless sobre PDFs de pólizas) en la próxima iteración:

| Campo | Descripción |
|---|---|
| `coverageApplies` | `covered` / `not_covered` / `requires_review` |
| `referenceClause` | Cláusula específica de la póliza que aplica |

### 5. Agregación final (`aggregate-risk`)

Recibe el output completo del `Parallel` y ejecuta dos fases:

#### Fase 1 — merge de documentos

Cuando hay múltiples documentos, se resuelven conflictos:

| Campo | Regla de merge |
|---|---|
| `claimType` | Primer valor no nulo encontrado |
| `estimatedAmount` | Valor máximo entre documentos |
| `incidentDate` | Primer valor no nulo |
| `involvedParties` | Unión de todas las partes (sin duplicados) |
| `descriptionSummary` | Primer valor no nulo |

Si diferentes documentos declaran `claimType` distintos → señal de fraude activa (+30 pts).

#### Fase 2 — cálculo del score de fraude (0–100)

| Señal | Puntos |
|---|---|
| Alteración detectada en algún documento | +50 |
| Documento de baja calidad | +20 |
| Partes inconsistentes dentro de un documento | +20 |
| Tipos de siniestro distintos entre documentos | +30 |
| Cliente con > 2 reclamos en los últimos 30 días | +25 |
| Score de integridad promedio × 0.15 | variable |

#### Priorización del reclamo

| Condición | Prioridad asignada |
|---|---|
| `fraudScore >= 60` O `amount > $50,000` | `high` |
| `fraudScore >= 30` | `medium` |
| Sin señales relevantes | `low` |

#### Resultado guardado en DynamoDB

```json
{
  "status": "processed",
  "claimType": "auto",
  "estimatedAmount": 3500.00,
  "incidentDate": "2026-08-15",
  "involvedParties": ["Juan Pérez", "María López"],
  "descriptionSummary": "Colisión frontal, daños en parachoques delantero.",
  "fraudRiskScore": 15,
  "riskJustification": "Documentación consistente, sin señales de alerta.",
  "coverageApplies": "requires_review",
  "requiresHumanReview": false,
  "priority": "low",
  "processedAt": "2026-08-29T14:32:00Z"
}
```

---

## Estructura del proyecto

```
.
├── apps/
│   ├── claims-api-handler/               # Lambda REST API (Hono)
│   │   └── src/modules/
│   │       ├── upload/                   # POST /upload/presign
│   │       ├── claim/                    # CRUD de reclamos + disparo de SF
│   │       └── auth/                     # JWT middleware
│   │
│   ├── process-claim-document/           # Handlers del pipeline de IA
│   │   └── src/
│   │       ├── handlers/
│   │       │   ├── sf.types.ts           # Contratos de I/O entre handlers
│   │       │   ├── extract-data.handler.ts        # Bedrock: extracción
│   │       │   ├── analyze-integrity.handler.ts   # Bedrock: análisis forense
│   │       │   ├── check-history.handler.ts       # DynamoDB: historial cliente
│   │       │   ├── check-coverage.handler.ts      # Bedrock KB: cobertura (stub)
│   │       │   └── aggregate-risk.handler.ts      # Merge + score + DynamoDB
│   │       ├── common/services/
│   │       │   ├── bedrock.service.ts    # extractFromDocument, analyzeIntegrity
│   │       │   └── s3.service.ts         # Descarga de documentos desde S3
│   │       └── modules/claim/
│   │           └── prompts.ts            # System prompts + tool schemas Nova Pro
│   │
│   └── dashboard/                        # Angular SPA (interfaz del ajustador)
│
└── infra/
    └── lib/base-stack.ts                 # CDK: toda la infraestructura AWS
```

---

## Modelo de datos — `ClaimsTable`

| Atributo | Tipo | Descripción |
|---|---|---|
| `id` (PK) | String | UUID del reclamo |
| `clientId` | String | ID del cliente — GSI para consultas por cliente |
| `status` | String | `pending` / `processing` / `processed` / `error` — GSI para cola del adjuster |
| `documents` | List | Array de `{ key, contentType, fileSizeBytes }` |
| `claimType` | String | Tipo de siniestro extraído por IA |
| `estimatedAmount` | Number | Monto estimado en USD |
| `fraudRiskScore` | Number | Score de fraude 0–100 |
| `riskJustification` | String | Señales detectadas concatenadas |
| `requiresHumanReview` | Boolean | `true` si score ≥ 60 |
| `priority` | String | `high` / `medium` / `low` — GSI para cola del adjuster |
| `coverageApplies` | String | `covered` / `not_covered` / `requires_review` |
| `processedAt` | String | ISO timestamp del procesamiento |

---

## Seguridad

- **Presigned URLs** con expiración de 5 min — archivos nunca pasan por Lambda
- **IAM mínimo privilegio** — cada Lambda tiene solo los permisos que necesita (3 roles distintos en SF)
- **Cifrado en reposo** — KMS managed en S3 y DynamoDB
- **Cifrado en tránsito** — HTTPS obligatorio en API Gateway
- **Bedrock Guardrails** *(próximo paso)* — filtra PII y asegura tono profesional en respuestas

---

## Costos estimados (Amazon Nova Pro)

| Volumen | Costo estimado / mes |
|---|---|
| 1,000 reclamos (2 docs c/u) | ~$14 |
| 10,000 reclamos (2 docs c/u) | ~$140 |
| 100,000 reclamos (2 docs c/u) | ~$1,400 |

*Nova Pro: $0.0008/1K tokens input, $0.0032/1K tokens output. ~4× más barato que Claude Sonnet.*

---

## Pasos pendientes

| Prioridad | Tarea |
|---|---|
| Media | Knowledge Base en Bedrock (OpenSearch Serverless + PDFs de pólizas) |
| Media | Conectar `check-coverage` con Bedrock KB (`Retrieve` API) |
| Baja | Bedrock Guardrails (filtrado PII, tono profesional) |
| Baja | Tests con documentos de muestra reales |
