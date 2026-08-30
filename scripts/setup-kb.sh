#!/usr/bin/env bash
# setup-kb.sh — create Bedrock Knowledge Base manually after CDK deploy
#
# Run this once after `cdk deploy AssistanceStack-Prod` succeeds.
# CloudFormation lacks bedrock:CreateKnowledgeBase in this account,
# so the KB is created here via CLI with the deployment role's permissions.
#
# Usage:
#   chmod +x scripts/setup-kb.sh
#   AWS_PROFILE=your-profile bash scripts/setup-kb.sh

set -euo pipefail

STACK="AssistanceStack-Prod"
REGION="us-east-1"

echo "==> Reading stack outputs..."

OS_ARN=$(aws cloudformation describe-stacks \
  --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='OpenSearchDomainArn'].OutputValue" \
  --output text)

OS_ENDPOINT=$(aws cloudformation describe-stacks \
  --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='OpenSearchDomainEndpoint'].OutputValue" \
  --output text)

KB_ROLE_ARN=$(aws cloudformation describe-stacks \
  --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='KnowledgeBaseRoleArn'].OutputValue" \
  --output text)

POLICIES_BUCKET=$(aws cloudformation describe-stacks \
  --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='PoliciesBucketName'].OutputValue" \
  --output text)

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)

echo "  OpenSearch ARN:      $OS_ARN"
echo "  OpenSearch Endpoint: $OS_ENDPOINT"
echo "  KB Role ARN:         $KB_ROLE_ARN"
echo "  Policies Bucket:     $POLICIES_BUCKET"

# ── Create Knowledge Base ─────────────────────────────────────────────────────

echo ""
echo "==> Creating Bedrock Knowledge Base..."

KB_ID=$(aws bedrock-agent create-knowledge-base \
  --name "assistance-prod-policies-kb" \
  --role-arn "$KB_ROLE_ARN" \
  --knowledge-base-configuration '{
    "type": "VECTOR",
    "vectorKnowledgeBaseConfiguration": {
      "embeddingModelArn": "arn:aws:bedrock:us-east-1::foundation-model/amazon.titan-embed-text-v2:0"
    }
  }' \
  --storage-configuration "{
    \"type\": \"OPENSEARCH_MANAGED_CLUSTER\",
    \"opensearchManagedClusterConfiguration\": {
      \"domainArn\": \"$OS_ARN\",
      \"domainEndpoint\": \"https://$OS_ENDPOINT\",
      \"vectorIndexName\": \"policies-index\",
      \"fieldMapping\": {
        \"vectorField\": \"bedrock-knowledge-base-default-vector\",
        \"textField\": \"AMAZON_BEDROCK_TEXT_CHUNK\",
        \"metadataField\": \"AMAZON_BEDROCK_METADATA\"
      }
    }
  }" \
  --region "$REGION" \
  --query "knowledgeBase.knowledgeBaseId" \
  --output text)

echo "  Knowledge Base ID: $KB_ID"

# ── Create Data Source ────────────────────────────────────────────────────────

echo ""
echo "==> Creating Data Source (S3 → KB)..."

DS_ID=$(aws bedrock-agent create-data-source \
  --knowledge-base-id "$KB_ID" \
  --name "assistance-prod-policies-docs" \
  --data-source-configuration "{
    \"type\": \"S3\",
    \"s3Configuration\": {
      \"bucketArn\": \"arn:aws:s3:::$POLICIES_BUCKET\"
    }
  }" \
  --vector-ingestion-configuration '{
    "chunkingConfiguration": {
      "chunkingStrategy": "FIXED_SIZE",
      "fixedSizeChunkingConfiguration": {
        "maxTokens": 512,
        "overlapPercentage": 20
      }
    }
  }' \
  --region "$REGION" \
  --query "dataSource.dataSourceId" \
  --output text)

echo "  Data Source ID: $DS_ID"

# ── Start ingestion ───────────────────────────────────────────────────────────

echo ""
echo "==> Starting ingestion job..."

JOB_ID=$(aws bedrock-agent start-ingestion-job \
  --knowledge-base-id "$KB_ID" \
  --data-source-id "$DS_ID" \
  --region "$REGION" \
  --query "ingestionJob.ingestionJobId" \
  --output text)

echo "  Ingestion Job ID: $JOB_ID"
echo "  Waiting for ingestion to complete (~2-3 min)..."

while true; do
  STATUS=$(aws bedrock-agent get-ingestion-job \
    --knowledge-base-id "$KB_ID" \
    --data-source-id "$DS_ID" \
    --ingestion-job-id "$JOB_ID" \
    --region "$REGION" \
    --query "ingestionJob.status" \
    --output text)
  echo "  Status: $STATUS"
  [[ "$STATUS" == "COMPLETE" ]] && break
  [[ "$STATUS" == "FAILED" ]] && echo "Ingestion FAILED" && exit 1
  sleep 15
done

# ── Inject KNOWLEDGE_BASE_ID into check-coverage Lambda ──────────────────────

echo ""
echo "==> Injecting KNOWLEDGE_BASE_ID into check-coverage Lambda..."

FUNCTION="assistance-prod-check-coverage"

CURRENT_ENV=$(aws lambda get-function-configuration \
  --function-name "$FUNCTION" \
  --region "$REGION" \
  --query "Environment.Variables" \
  --output json)

UPDATED_ENV=$(echo "$CURRENT_ENV" | \
  python3 -c "import sys,json; e=json.load(sys.stdin); e['KNOWLEDGE_BASE_ID']='$KB_ID'; print(json.dumps({'Variables': e}))")

aws lambda update-function-configuration \
  --function-name "$FUNCTION" \
  --region "$REGION" \
  --environment "$UPDATED_ENV" \
  --query "FunctionName" \
  --output text

echo ""
echo "======================================================"
echo "  Knowledge Base ready!"
echo "  KB ID:     $KB_ID"
echo "  DS ID:     $DS_ID"
echo "  Documents: $(aws s3 ls s3://$POLICIES_BUCKET/ | wc -l) files ingested"
echo "======================================================"
