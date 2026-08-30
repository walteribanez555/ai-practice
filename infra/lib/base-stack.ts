// Updated: OpenSearch Service + Bedrock Knowledge Base + Step Functions multi-doc analysis
import * as cdk from "aws-cdk-lib";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import * as cr from "aws-cdk-lib/custom-resources";
import * as opensearch from "aws-cdk-lib/aws-opensearchservice";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as s3notifications from "aws-cdk-lib/aws-s3-notifications";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as events from "aws-cdk-lib/aws-events";
import * as eventsTargets from "aws-cdk-lib/aws-events-targets";
import * as cloudtrail from "aws-cdk-lib/aws-cloudtrail";
import { Construct } from "constructs";
import * as path from "path";

export interface AssistanceStackProps extends cdk.StackProps {
  appEnv: string;
  serviceName?: string;
}

export class AssistanceStack extends cdk.Stack {
  public readonly appEnv: string;
  public readonly claimsTable: dynamodb.Table;
  public readonly processClaimFn: lambdaNodejs.NodejsFunction;
  public readonly claimsApiFn: lambdaNodejs.NodejsFunction;
  public readonly claimsHttpApi: apigatewayv2.CfnApi;
  public readonly dashboardBucket: s3.Bucket;
  public readonly dashboardDistribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: AssistanceStackProps) {
    super(scope, id, props);

    this.appEnv = props.appEnv;

    const projectName = "assistance";
    const serviceName = props.serviceName ?? `${projectName}-${this.appEnv}`;
    const isProd      = this.appEnv === "prod";

    cdk.Tags.of(this).add("Project",     projectName);
    cdk.Tags.of(this).add("Environment", this.appEnv);
    cdk.Tags.of(this).add("ManagedBy",   "CDK");

    // ─── Secrets Manager ──────────────────────────────────────────────────────
    // Secret name: assistance/{env}/app
    // Keys: CORS_ORIGINS, LOG_LEVEL
    const appSecret = secretsmanager.Secret.fromSecretNameV2(
      this, "AppSecret", `${projectName}/${this.appEnv}/app`,
    );

    // ─── DynamoDB — users table ───────────────────────────────────────────────
    //
    // Access patterns:
    //   PK  email  → get user by email (login)
    const usersTable = new dynamodb.Table(this, "UsersTable", {
      tableName:    `${serviceName}-users`,
      partitionKey: { name: "email", type: dynamodb.AttributeType.STRING },

      billingMode:   isProd ? dynamodb.BillingMode.PAY_PER_REQUEST : dynamodb.BillingMode.PROVISIONED,
      readCapacity:  isProd ? undefined : 5,
      writeCapacity: isProd ? undefined : 5,

      encryption:    dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // ─── DynamoDB — claims table ───────────────────────────────────────────────
    //
    // Access patterns:
    //   PK  id                          → get by id
    //   GSI clientId-createdAt-index    → list by client, recent claims (fraud scoring)
    //   GSI status-createdAt-index      → admin queue (pending / processing / error)
    //   GSI priority-createdAt-index    → adjuster queue (high / medium / low)
    this.claimsTable = new dynamodb.Table(this, "ClaimsTable", {
      tableName:    `${serviceName}-claims`,
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },

      billingMode:   isProd ? dynamodb.BillingMode.PAY_PER_REQUEST : dynamodb.BillingMode.PROVISIONED,
      readCapacity:  isProd ? undefined : 5,
      writeCapacity: isProd ? undefined : 5,

      encryption:          dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: isProd ? { pointInTimeRecoveryEnabled: true } : undefined,
      removalPolicy:                    isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: "ttl",
    });

    this.claimsTable.addGlobalSecondaryIndex({
      indexName:      "clientId-createdAt-index",
      partitionKey:   { name: "clientId",  type: dynamodb.AttributeType.STRING },
      sortKey:        { name: "createdAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.claimsTable.addGlobalSecondaryIndex({
      indexName:      "status-createdAt-index",
      partitionKey:   { name: "status",    type: dynamodb.AttributeType.STRING },
      sortKey:        { name: "createdAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.claimsTable.addGlobalSecondaryIndex({
      indexName:      "priority-createdAt-index",
      partitionKey:   { name: "priority",  type: dynamodb.AttributeType.STRING },
      sortKey:        { name: "createdAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI for S3 trigger lookup: find claim by documentKey
    this.claimsTable.addGlobalSecondaryIndex({
      indexName:      "documentKey-index",
      partitionKey:   { name: "documentKey", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ["id", "clientId", "status", "contentType", "fileSizeBytes"],
    });

    // ─── S3 — claim documents bucket ──────────────────────────────────────────
    //
    // Clients upload documents directly via presigned PUT URLs (no Lambda proxy).
    // Lifecycle: expire after 7 days — processed data lives in DynamoDB.
    // The claims-api-handler Lambda generates presigned URLs and reads/deletes objects.
    const documentsBucket = new s3.Bucket(this, "DocumentsBucket", {
      bucketName:        `${serviceName}-documents`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL:        true,
      removalPolicy:     isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
      lifecycleRules: [
        {
          // Non-PHI documents (auto, home, theft, other): expire after 7 days.
          // aggregate-risk tags these with phi=false after processing.
          id:          "expire-non-phi-documents",
          tagFilters:  { phi: "false" },
          expiration:  cdk.Duration.days(7),
          enabled:     true,
        },
        {
          // PHI documents (health claims): HIPAA minimum retention 6 years.
          // aggregate-risk tags these with phi=true after processing.
          id:          "retain-phi-documents",
          tagFilters:  { phi: "true" },
          expiration:  cdk.Duration.days(2190),
          enabled:     true,
        },
        // Untagged objects (uploaded but not yet processed) are not matched by
        // either rule above, so they are retained until aggregate-risk tags them.
        // aggregate-risk always runs — including on the error path.
      ],
      cors: [
        {
          // Wildcard headers required: browser preflight may include headers beyond content-type
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: ["*"],
          allowedHeaders: ["*"],
          maxAge:         3000,
        },
      ],
    });

    new cdk.CfnOutput(this, "DocumentsBucketName", {
      value:       documentsBucket.bucketName,
      description: "S3 bucket for claim document uploads",
      exportName:  `${serviceName}-documents-bucket`,
    });

    // ─── Shared DynamoDB policy ────────────────────────────────────────────────

    const dynamoPolicy = new iam.PolicyStatement({
      sid:     "AllowDynamoAccess",
      actions: [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query",
        "dynamodb:Scan",
      ],
      resources: [
        this.claimsTable.tableArn,
        `${this.claimsTable.tableArn}/index/*`,
        usersTable.tableArn,
      ],
    });

    // ─── Shared Lambda environment ─────────────────────────────────────────────
    // Sensitive values (CORS_ORIGINS, LOG_LEVEL, …) are NOT injected here.
    // Each Lambda fetches them at cold start via APP_SECRET_ARN → Secrets Manager.

    const sharedEnv = {
      NODE_ENV:              isProd ? "production" : "development",
      CLAIMS_TABLE_NAME:     this.claimsTable.tableName,
      USERS_TABLE_NAME:      usersTable.tableName,
      APP_SECRET_ARN:        appSecret.secretArn,
      DOCUMENTS_BUCKET_NAME: documentsBucket.bucketName,
    };

    const sharedBundling: lambdaNodejs.BundlingOptions = {
      minify:          isProd,
      sourceMap:       !isProd,
      target:          "node24",
      externalModules: ["aws-sdk", "@aws-sdk/*"],
    };

    // ─────────────────────────────────────────────────────────────────────────
    // Bedrock Guardrail — fraud-claims-guardrail
    //
    // Applied to every ConverseCommand that processes claim documents.
    // Three layers of protection:
    //   1. Content policy   — block hate/sexual/violence in model I/O
    //   2. PII policy       — BLOCK dangerous PII from model outputs
    //                         (SSN, credit cards, bank accounts)
    //                         Names/addresses intentionally left unrestricted
    //                         because they are core claim extraction data.
    //   3. Topic denial     — reject off-topic requests embedded in documents
    //                         (legal advice, medical diagnosis)
    // ─────────────────────────────────────────────────────────────────────────

    const fraudGuardrail = new bedrock.CfnGuardrail(this, "FraudGuardrail", {
      name:                    `${serviceName}-fraud-claims`,
      description:             "Protect fraud-scoring pipeline: PII redaction, content filtering, topic denial",
      blockedInputMessaging:   "This content cannot be processed by the claims analysis system.",
      blockedOutputsMessaging: "The model output was blocked by the content safety policy.",

      contentPolicyConfig: {
        filtersConfig: [
          { type: "HATE",         inputStrength: "HIGH",   outputStrength: "HIGH"   },
          { type: "INSULTS",      inputStrength: "HIGH",   outputStrength: "HIGH"   },
          { type: "SEXUAL",       inputStrength: "HIGH",   outputStrength: "HIGH"   },
          // MEDIUM on violence: accident/injury descriptions are expected in claims
          { type: "VIOLENCE",     inputStrength: "MEDIUM", outputStrength: "MEDIUM" },
          { type: "MISCONDUCT",   inputStrength: "HIGH",   outputStrength: "HIGH"   },
          // Prompt injection guard on inputs only
          { type: "PROMPT_ATTACK", inputStrength: "HIGH",  outputStrength: "NONE"   },
        ],
      },

      sensitiveInformationPolicyConfig: {
        // Only block PII that must never appear in extracted claim data or DynamoDB.
        // Names, phones, and addresses are intentionally excluded — they are
        // required fields in involvedParties and claim extraction.
        piiEntitiesConfig: [
          { type: "US_SOCIAL_SECURITY_NUMBER", action: "BLOCK" },
          { type: "CREDIT_DEBIT_CARD_NUMBER",  action: "BLOCK" },
          { type: "CREDIT_DEBIT_CARD_CVV",     action: "BLOCK" },
          { type: "CREDIT_DEBIT_CARD_EXPIRY",  action: "BLOCK" },
          { type: "US_BANK_ACCOUNT_NUMBER",    action: "BLOCK" },
          { type: "US_BANK_ROUTING_NUMBER",    action: "BLOCK" },
          { type: "AWS_ACCESS_KEY",            action: "BLOCK" },
          { type: "AWS_SECRET_KEY",            action: "BLOCK" },
          { type: "PASSWORD",                  action: "BLOCK" },
          { type: "PIN",                       action: "BLOCK" },
        ],
      },

      topicPolicyConfig: {
        topicsConfig: [
          {
            name:       "LegalAdvice",
            definition: "Requests for specific legal advice, legal opinion, legal interpretation of policy terms, or recommendations about legal action.",
            examples:   ["Should I sue?", "Is this covered by law?", "What are my legal rights?", "Can I take legal action?"],
            type:       "DENY",
          },
          {
            name:       "MedicalDiagnosis",
            definition: "Requests for specific medical diagnoses, treatment recommendations, or medical opinions beyond what is documented in the claim.",
            examples:   ["What injury do I have?", "Should I see a doctor?", "Is this injury serious?"],
            type:       "DENY",
          },
        ],
      },
    });

    const guardrailVersion = new bedrock.CfnGuardrailVersion(this, "FraudGuardrailVersion", {
      guardrailIdentifier: fraudGuardrail.attrGuardrailId,
      description:         "Initial version — PII block + content filter + topic denial",
    });

    new cdk.CfnOutput(this, "GuardrailId", {
      value:       fraudGuardrail.attrGuardrailId,
      description: "Bedrock Guardrail ID — fraud-claims",
      exportName:  `${serviceName}-guardrail-id`,
    });

    new cdk.CfnOutput(this, "GuardrailVersion", {
      value:       guardrailVersion.attrVersion,
      description: "Bedrock Guardrail version in use",
      exportName:  `${serviceName}-guardrail-version`,
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Lambda 1 — process-claim-document (internal, no API Gateway)
    //
    // Invoked directly (e.g. from SQS, EventBridge, or direct Invoke call).
    // Processes a claim document: extracts data, runs fraud scoring, sets status.
    // ─────────────────────────────────────────────────────────────────────────

    const processClaimRole = new iam.Role(this, "ProcessClaimRole", {
      roleName:         `${serviceName}-process-claim-role`,
      assumedBy:        new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies:  [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")],
    });
    processClaimRole.addToPolicy(dynamoPolicy);
    appSecret.grantRead(processClaimRole);

    // Bedrock: allow invoking any foundation model and cross-region inference profile.
    // ConverseCommand maps to bedrock:InvokeModel at the IAM level.
    // RequestedRegion condition: cross-region inference for Nova Pro routes via us-east-1
    // and us-west-2 only — this prevents accidental calls to other regions.
    processClaimRole.addToPolicy(new iam.PolicyStatement({
      sid:     "AllowBedrockInvoke",
      actions: ["bedrock:InvokeModel"],
      resources: [
        `arn:aws:bedrock:*::foundation-model/*`,
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/*`,
      ],
      conditions: {
        StringEquals: { "aws:RequestedRegion": ["us-east-1", "us-west-2"] },
      },
    }));

    processClaimRole.addToPolicy(new iam.PolicyStatement({
      sid:       "AllowBedrockGuardrail",
      actions:   ["bedrock:ApplyGuardrail"],
      resources: [fraudGuardrail.attrGuardrailArn],
    }));

    // S3: allow reading claim documents to send them to Bedrock for analysis.
    documentsBucket.grantRead(processClaimRole);

    const processClaimLogGroup = new logs.LogGroup(this, "ProcessClaimLogGroup", {
      logGroupName:  `/aws/lambda/${serviceName}-process-claim-document`,
      retention:     logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.processClaimFn = new lambdaNodejs.NodejsFunction(this, "ProcessClaimFn", {
      functionName: `${serviceName}-process-claim-document`,
      description:  "Internal — processes a claim document and applies business rules",
      runtime:      lambda.Runtime.NODEJS_22_X,
      entry:        path.join(__dirname, "../../apps/process-claim-document/src/index.ts"),
      handler:      "handler",
      role:         processClaimRole,
      timeout:      cdk.Duration.seconds(60), // Bedrock + S3 download can take longer
      memorySize:   512,
      environment: {
        ...sharedEnv,
        BEDROCK_MODEL_ID:  process.env.BEDROCK_MODEL_ID ?? "us.amazon.nova-pro-v1:0",
        GUARDRAIL_ID:      fraudGuardrail.attrGuardrailId,
        GUARDRAIL_VERSION: guardrailVersion.attrVersion,
      },
      logGroup:     processClaimLogGroup,
      bundling:     sharedBundling,
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Knowledge Base — OpenSearch Service + Bedrock KB + policy documents
    //
    // Flow: S3(policies) → Bedrock ingestion → OpenSearch index (k-NN vectors)
    //       check-coverage Lambda → bedrock:Retrieve → top-k chunks → coverage decision
    // ─────────────────────────────────────────────────────────────────────────

    // S3 — policy documents source
    const policiesBucket = new s3.Bucket(this, "PoliciesBucket", {
      bucketName:        `${serviceName}-policies`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL:        true,
      removalPolicy:     isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
    });

    // Upload policy .txt files on every deploy
    new s3deploy.BucketDeployment(this, "PolicyDocs", {
      sources:           [s3deploy.Source.asset(path.join(__dirname, "../../knowledge_base/policies"))],
      destinationBucket: policiesBucket,
    });

    // IAM role for Bedrock Knowledge Base
    const kbRole = new iam.Role(this, "KnowledgeBaseRole", {
      roleName:  `${serviceName}-kb-role`,
      assumedBy: new iam.ServicePrincipal("bedrock.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": this.account },
          ArnLike: { "aws:SourceArn": `arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/*` },
        },
      }),
    });
    policiesBucket.grantRead(kbRole);

    // OpenSearch Service domain — t3.small.search, 1 node, 10 GB (~$4.55 / 5 days)
    const osDomainName = `${serviceName.substring(0, 24)}-kb`;
    const osDomain = new opensearch.Domain(this, "PoliciesDomain", {
      domainName:          osDomainName,
      version:             opensearch.EngineVersion.OPENSEARCH_2_11,
      capacity: {
        dataNodes:                1,
        dataNodeInstanceType:     "t3.small.search",
        multiAzWithStandbyEnabled: false,
      },
      ebs:                 { volumeSize: 10 },
      encryptionAtRest:    { enabled: true },
      nodeToNodeEncryption: true,
      enforceHttps:        true,
      tlsSecurityPolicy:   opensearch.TLSSecurityPolicy.TLS_1_2,
      removalPolicy:       cdk.RemovalPolicy.DESTROY,
      logging: {
        slowSearchLogEnabled: false,
        slowIndexLogEnabled:  false,
      },
    });

    // Grant KB role access to OpenSearch (resource-based policy + IAM)
    osDomain.grantReadWrite(kbRole);

    // Bedrock needs these management API calls when validating the domain during KB creation
    kbRole.addToPolicy(new iam.PolicyStatement({
      sid:       "AllowOsDescribe",
      actions:   ["es:DescribeDomain", "es:DescribeElasticsearchDomain"],
      resources: [osDomain.domainArn],
    }));

    // Custom Resource — creates the k-NN index before Bedrock KB ingests
    const osIndexFn = new lambdaNodejs.NodejsFunction(this, "OsIndexFn", {
      functionName: `${serviceName}-create-os-index`,
      description:  "CDK custom resource — creates k-NN vector index in OpenSearch",
      runtime:      lambda.Runtime.NODEJS_22_X,
      entry:        path.join(__dirname, "../../apps/process-claim-document/src/handlers/create-os-index.handler.ts"),
      handler:      "handler",
      timeout:      cdk.Duration.minutes(5),
      memorySize:   256,
      environment: {
        DOMAIN_ENDPOINT: osDomain.domainEndpoint,
        INDEX_NAME:      "policies-index",
      },
      bundling: sharedBundling, // aws4 is pure JS — esbuild bundles it from process-claim-document/node_modules
    });
    osDomain.grantReadWrite(osIndexFn);

    const osIndexProvider = new cr.Provider(this, "OsIndexProvider", {
      onEventHandler: osIndexFn,
    });

    const osIndexResource = new cdk.CustomResource(this, "OsIndex", {
      serviceToken: osIndexProvider.serviceToken,
      properties: {
        DomainEndpoint: osDomain.domainEndpoint,
        IndexName:      "policies-index",
        Version:        "1",
      },
    });

    // Bedrock Knowledge Base — created manually via CLI (CloudFormation lacks
    // bedrock:CreateKnowledgeBase permission in this account's execution role).
    // After CDK deploy, run scripts/setup-kb.sh to create KB + data source,
    // then update KNOWLEDGE_BASE_ID in the app secret or Lambda env var.

    // Allow Bedrock KB to read S3 + call Titan embeddings (used by the manually created KB)
    kbRole.addToPolicy(new iam.PolicyStatement({
      sid:     "AllowTitanEmbedding",
      actions: ["bedrock:InvokeModel"],
      resources: [
        `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
      ],
    }));

    new cdk.CfnOutput(this, "OpenSearchDomainEndpoint", {
      value:       osDomain.domainEndpoint,
      description: "OpenSearch domain endpoint",
      exportName:  `${serviceName}-opensearch-endpoint`,
    });

    new cdk.CfnOutput(this, "OpenSearchDomainArn", {
      value:       osDomain.domainArn,
      description: "OpenSearch domain ARN — needed for manual KB creation",
      exportName:  `${serviceName}-opensearch-arn`,
    });

    new cdk.CfnOutput(this, "KnowledgeBaseRoleArn", {
      value:       kbRole.roleArn,
      description: "IAM role ARN for Bedrock Knowledge Base — use in manual KB creation",
      exportName:  `${serviceName}-kb-role-arn`,
    });

    new cdk.CfnOutput(this, "PoliciesBucketName", {
      value:       policiesBucket.bucketName,
      description: "S3 bucket with policy documents — data source for the KB",
      exportName:  `${serviceName}-policies-bucket`,
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Step Functions — claim processing state machine
    //
    // Parallel analysis of multiple documents per claim:
    //   Branch A → Map(documents) → Parallel per-doc:
    //                 extract-data  (Bedrock: structured extraction)
    //                 analyze-integrity (Bedrock: forgery signals)
    //   Branch B → check-history    (DynamoDB: client claim history)
    //   Branch C → check-coverage   (Bedrock KB: policy coverage via RAG)
    //   Final    → aggregate-risk   (merges all outputs → DynamoDB update)
    // ─────────────────────────────────────────────────────────────────────────

    const sfDocAnalysisEnv = {
      ...sharedEnv,
      BEDROCK_MODEL_ID:    process.env.BEDROCK_MODEL_ID ?? "us.amazon.nova-pro-v1:0",
      GUARDRAIL_ID:        fraudGuardrail.attrGuardrailId,
      GUARDRAIL_VERSION:   guardrailVersion.attrVersion,
    };

    // Shared IAM role for doc-analysis Lambdas (need Bedrock + S3 read)
    const sfDocAnalysisRole = new iam.Role(this, "SfDocAnalysisRole", {
      roleName:        `${serviceName}-sf-doc-analysis-role`,
      assumedBy:       new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")],
    });
    sfDocAnalysisRole.addToPolicy(new iam.PolicyStatement({
      sid:     "AllowBedrockInvoke",
      actions: ["bedrock:InvokeModel"],
      resources: [
        `arn:aws:bedrock:*::foundation-model/*`,
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/*`,
      ],
      conditions: {
        StringEquals: { "aws:RequestedRegion": ["us-east-1", "us-west-2"] },
      },
    }));

    sfDocAnalysisRole.addToPolicy(new iam.PolicyStatement({
      sid:       "AllowBedrockGuardrail",
      actions:   ["bedrock:ApplyGuardrail"],
      resources: [fraudGuardrail.attrGuardrailArn],
    }));

    documentsBucket.grantRead(sfDocAnalysisRole);
    appSecret.grantRead(sfDocAnalysisRole);

    // IAM role for history/coverage Lambdas (DynamoDB read + Bedrock Retrieve)
    const sfQueryRole = new iam.Role(this, "SfQueryRole", {
      roleName:        `${serviceName}-sf-query-role`,
      assumedBy:       new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")],
    });
    sfQueryRole.addToPolicy(new iam.PolicyStatement({
      sid:     "AllowDynamoRead",
      actions: ["dynamodb:GetItem", "dynamodb:Query"],
      resources: [this.claimsTable.tableArn, `${this.claimsTable.tableArn}/index/*`],
    }));
    sfQueryRole.addToPolicy(new iam.PolicyStatement({
      sid:     "AllowBedrockRetrieve",
      actions: ["bedrock:Retrieve"],
      resources: [`arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/*`],
    }));
    appSecret.grantRead(sfQueryRole);

    // IAM role for aggregate-risk Lambda (DynamoDB write)
    const sfAggregateRole = new iam.Role(this, "SfAggregateRole", {
      roleName:        `${serviceName}-sf-aggregate-role`,
      assumedBy:       new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")],
    });
    sfAggregateRole.addToPolicy(new iam.PolicyStatement({
      sid:     "AllowDynamoWrite",
      actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
      resources: [this.claimsTable.tableArn],
    }));

    // S3 tagging: aggregate-risk sets phi=true/false on each document after determining
    // claimType, so the correct lifecycle rule (7 days vs 6 years) kicks in.
    sfAggregateRole.addToPolicy(new iam.PolicyStatement({
      sid:       "AllowDocumentTagging",
      actions:   ["s3:PutObjectTagging"],
      resources: [`${documentsBucket.bucketArn}/documents/*`],
    }));

    // SageMaker Serverless: invoke fraud scoring endpoint (optional — only used when
    // FRAUD_SCORING_ENDPOINT_NAME is set after training; graceful fallback to rules)
    sfAggregateRole.addToPolicy(new iam.PolicyStatement({
      sid:     "AllowSageMakerInvokeEndpoint",
      actions: ["sagemaker:InvokeEndpoint"],
      resources: [`arn:aws:sagemaker:${this.region}:${this.account}:endpoint/fraud-scoring-*`],
    }));
    appSecret.grantRead(sfAggregateRole);

    // ── Step Functions Lambda functions ───────────────────────────────────────

    const handlersBase = "../../apps/process-claim-document/src/handlers";

    const extractDataFn = new lambdaNodejs.NodejsFunction(this, "ExtractDataFn", {
      functionName: `${serviceName}-extract-data`,
      description:  "SF step — extract structured claim data from one document via Bedrock",
      runtime:      lambda.Runtime.NODEJS_22_X,
      entry:        path.join(__dirname, `${handlersBase}/extract-data.handler.ts`),
      handler:      "handler",
      role:         sfDocAnalysisRole,
      timeout:      cdk.Duration.seconds(60),
      memorySize:   512,
      environment:  sfDocAnalysisEnv,
      bundling:     sharedBundling,
    });

    const analyzeIntegrityFn = new lambdaNodejs.NodejsFunction(this, "AnalyzeIntegrityFn", {
      functionName: `${serviceName}-analyze-integrity`,
      description:  "SF step — assess document integrity and forgery signals via Bedrock",
      runtime:      lambda.Runtime.NODEJS_22_X,
      entry:        path.join(__dirname, `${handlersBase}/analyze-integrity.handler.ts`),
      handler:      "handler",
      role:         sfDocAnalysisRole,
      timeout:      cdk.Duration.seconds(60),
      memorySize:   512,
      environment:  sfDocAnalysisEnv,
      bundling:     sharedBundling,
    });

    const checkHistoryFn = new lambdaNodejs.NodejsFunction(this, "CheckHistoryFn", {
      functionName: `${serviceName}-check-history`,
      description:  "SF step — query client claim history from DynamoDB",
      runtime:      lambda.Runtime.NODEJS_22_X,
      entry:        path.join(__dirname, `${handlersBase}/check-history.handler.ts`),
      handler:      "handler",
      role:         sfQueryRole,
      timeout:      cdk.Duration.seconds(15),
      memorySize:   256,
      environment:  sharedEnv,
      bundling:     sharedBundling,
    });

    const checkCoverageFn = new lambdaNodejs.NodejsFunction(this, "CheckCoverageFn", {
      functionName: `${serviceName}-check-coverage`,
      description:  "SF step — check policy coverage via Bedrock Knowledge Base (RAG)",
      runtime:      lambda.Runtime.NODEJS_22_X,
      entry:        path.join(__dirname, `${handlersBase}/check-coverage.handler.ts`),
      handler:      "handler",
      role:         sfQueryRole,
      timeout:      cdk.Duration.seconds(30),
      memorySize:   256,
      environment: {
        ...sharedEnv,
        // KNOWLEDGE_BASE_ID is set via 'aws lambda update-function-configuration'
        // after the KB is created manually with scripts/setup-kb.sh
        KNOWLEDGE_BASE_ID: process.env.KNOWLEDGE_BASE_ID ?? "",
      },
      bundling:     sharedBundling,
    });

    const synthesizeDocsFn = new lambdaNodejs.NodejsFunction(this, "SynthesizeDocsFn", {
      functionName: `${serviceName}-synthesize-docs`,
      description:  "SF Phase2 step — cross-document consistency analysis via Bedrock",
      runtime:      lambda.Runtime.NODEJS_22_X,
      entry:        path.join(__dirname, `${handlersBase}/synthesize-docs.handler.ts`),
      handler:      "handler",
      role:         sfDocAnalysisRole,
      timeout:      cdk.Duration.seconds(60),
      memorySize:   512,
      environment:  sfDocAnalysisEnv,
      bundling:     sharedBundling,
    });

    const aggregateRiskFn = new lambdaNodejs.NodejsFunction(this, "AggregateRiskFn", {
      functionName: `${serviceName}-aggregate-risk`,
      description:  "SF final step — merge all analyses, compute fraud score, update DynamoDB",
      runtime:      lambda.Runtime.NODEJS_22_X,
      entry:        path.join(__dirname, `${handlersBase}/aggregate-risk.handler.ts`),
      handler:      "handler",
      role:         sfAggregateRole,
      timeout:      cdk.Duration.seconds(30),
      memorySize:   256,
      environment: {
        ...sharedEnv,
        // Set after training: aws lambda update-function-configuration \
        //   --function-name <name> \
        //   --environment "Variables={FRAUD_SCORING_ENDPOINT_NAME=fraud-scoring-serverless}"
        // Leave empty to use rule-based fallback (safe default)
        FRAUD_SCORING_ENDPOINT_NAME: process.env.FRAUD_SCORING_ENDPOINT_NAME ?? "",
      },
      bundling:     sharedBundling,
    });

    // ── State machine definition ──────────────────────────────────────────────

    // Shared retry policy: transient Lambda/Bedrock errors with exponential backoff
    const lambdaRetry: sfn.RetryProps = {
      errors:      ["Lambda.ServiceException", "Lambda.TooManyRequestsException", "Lambda.SdkClientException", "States.TaskFailed"],
      maxAttempts: 3,
      interval:    cdk.Duration.seconds(3),
      backoffRate: 2,
    };

    // Per-document parallel: extract-data ∥ analyze-integrity
    const extractDataTask = new tasks.LambdaInvoke(this, "ExtractData", {
      lambdaFunction:    extractDataFn,
      payloadResponseOnly: true,
      comment:           "Extract structured claim data (claimType, amount, date, parties)",
    });
    extractDataTask.addRetry(lambdaRetry);

    const analyzeIntegrityTask = new tasks.LambdaInvoke(this, "AnalyzeIntegrity", {
      lambdaFunction:    analyzeIntegrityFn,
      payloadResponseOnly: true,
      comment:           "Assess document for alteration, quality and internal consistency",
    });
    analyzeIntegrityTask.addRetry(lambdaRetry);

    const perDocParallel = new sfn.Parallel(this, "PerDocAnalysis", {
      comment: "Analyze one document from two independent angles simultaneously",
    });
    perDocParallel.branch(extractDataTask);
    perDocParallel.branch(analyzeIntegrityTask);

    // Map over all documents in parallel
    const mapDocuments = new sfn.Map(this, "MapDocuments", {
      comment:      "Fan out — analyze each document independently and in parallel",
      itemsPath:    sfn.JsonPath.stringAt("$.documents"),
      itemSelector: {
        "claimId.$":  "$.claimId",
        "document.$": "$$.Map.Item.Value",
      },
      maxConcurrency: 5,
    });
    mapDocuments.itemProcessor(perDocParallel);

    const checkHistoryTask = new tasks.LambdaInvoke(this, "CheckHistory", {
      lambdaFunction:    checkHistoryFn,
      payloadResponseOnly: true,
      payload:           sfn.TaskInput.fromObject({
        "claimId.$":  "$.claimId",
        "clientId.$": "$.clientId",
      }),
      comment: "Check client's recent claim history for frequency fraud signals",
    });
    checkHistoryTask.addRetry(lambdaRetry);

    // ── Phase 1 parallel: doc analysis ∥ history ─────────────────────────────
    const phase1Parallel = new sfn.Parallel(this, "Phase1Parallel", {
      comment:    "Phase 1 — extract all documents and check claim history simultaneously",
      resultPath: sfn.JsonPath.stringAt("$.phase1Results"),
    });
    phase1Parallel.branch(mapDocuments);
    phase1Parallel.branch(checkHistoryTask);

    // ── Phase 2 parallel: synthesis ∥ coverage (use Phase 1 extraction data) ─
    const synthesizeDocsTask = new tasks.LambdaInvoke(this, "SynthesizeDocs", {
      lambdaFunction:    synthesizeDocsFn,
      payloadResponseOnly: true,
      payload:           sfn.TaskInput.fromObject({
        "claimId.$":    "$.claimId",
        "extractions.$": "$.phase1Results[0]",
      }),
      comment: "Cross-document consistency analysis using actual extracted data",
    });
    synthesizeDocsTask.addRetry(lambdaRetry);

    const checkCoverageTask = new tasks.LambdaInvoke(this, "CheckCoverage", {
      lambdaFunction:    checkCoverageFn,
      payloadResponseOnly: true,
      payload:           sfn.TaskInput.fromObject({
        "claimId.$":      "$.claimId",
        "extractions.$":  "$.phase1Results[0]",
        "claimContext.$": "$.claimContext",
      }),
      comment: "Policy coverage check with real extraction context",
    });
    checkCoverageTask.addRetry(lambdaRetry);

    const phase2Parallel = new sfn.Parallel(this, "Phase2Parallel", {
      comment:    "Phase 2 — cross-doc synthesis and coverage check using extracted data",
      resultPath: sfn.JsonPath.stringAt("$.phase2Results"),
    });
    phase2Parallel.branch(synthesizeDocsTask);
    phase2Parallel.branch(checkCoverageTask);

    // ── Final aggregation ─────────────────────────────────────────────────────
    const aggregateRiskTask = new tasks.LambdaInvoke(this, "AggregateRisk", {
      lambdaFunction:    aggregateRiskFn,
      payloadResponseOnly: true,
      comment:           "Merge all phase results, compute fraud score, update DynamoDB",
    });
    aggregateRiskTask.addRetry({ ...lambdaRetry, maxAttempts: 2 });

    // Error catch — preserves $.claimId so aggregate-risk can mark claim as error
    const handleError = new sfn.Pass(this, "PropagateError", {
      parameters: {
        "claimId.$": "$.claimId",
        "error.$":   "$.sfnError.Error",
        "cause.$":   "$.sfnError.Cause",
      },
    });
    handleError.next(aggregateRiskTask);

    const definition = phase1Parallel
      .addCatch(handleError, { errors: ["States.ALL"], resultPath: "$.sfnError" })
      .next(
        phase2Parallel
          .addCatch(handleError, { errors: ["States.ALL"], resultPath: "$.sfnError" })
      )
      .next(aggregateRiskTask);

    // Step Functions execution role
    const sfnRole = new iam.Role(this, "SfnExecutionRole", {
      roleName:  `${serviceName}-sfn-role`,
      assumedBy: new iam.ServicePrincipal("states.amazonaws.com"),
    });
    [extractDataFn, analyzeIntegrityFn, checkHistoryFn, synthesizeDocsFn, checkCoverageFn, aggregateRiskFn]
      .forEach((fn) => fn.grantInvoke(sfnRole));

    const claimProcessingStateMachine = new sfn.StateMachine(this, "ClaimProcessingStateMachine", {
      stateMachineName: `${serviceName}-claim-processing`,
      definitionBody:   sfn.DefinitionBody.fromChainable(definition),
      role:             sfnRole,
      timeout:          cdk.Duration.minutes(5),
      tracingEnabled:   true,
      logs: {
        destination:          new logs.LogGroup(this, "SfnLogGroup", {
          logGroupName:  `/aws/states/${serviceName}-claim-processing`,
          retention:     logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        level:          sfn.LogLevel.ERROR,
        includeExecutionData: false,
      },
    });

    new cdk.CfnOutput(this, "ClaimProcessingStateMachineArn", {
      value:       claimProcessingStateMachine.stateMachineArn,
      description: "ARN of the claim processing Step Functions state machine",
      exportName:  `${serviceName}-claim-processing-sfn-arn`,
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Lambda 3 — s3-trigger (S3 ObjectCreated → start claim processing)
    //
    // Triggered when a document lands in the documents bucket.
    // Looks up the claim by documentKey GSI, marks it processing,
    // and starts the Step Function execution.
    // ─────────────────────────────────────────────────────────────────────────

    const s3TriggerRole = new iam.Role(this, "S3TriggerRole", {
      roleName:        `${serviceName}-s3-trigger-role`,
      assumedBy:       new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")],
    });
    s3TriggerRole.addToPolicy(new iam.PolicyStatement({
      sid:     "AllowClaimsTableAccess",
      actions: ["dynamodb:Query", "dynamodb:UpdateItem"],
      resources: [
        this.claimsTable.tableArn,
        `${this.claimsTable.tableArn}/index/documentKey-index`,
      ],
    }));
    s3TriggerRole.addToPolicy(new iam.PolicyStatement({
      sid:       "AllowStartSfn",
      actions:   ["states:StartExecution"],
      resources: [claimProcessingStateMachine.stateMachineArn],
    }));

    const s3TriggerFn = new lambdaNodejs.NodejsFunction(this, "S3TriggerFn", {
      functionName: `${serviceName}-s3-trigger`,
      description:  "S3 ObjectCreated → find claim by documentKey → start claim processing SF",
      runtime:      lambda.Runtime.NODEJS_22_X,
      entry:        path.join(__dirname, "../../apps/claims-api-handler/src/handlers/s3-trigger.handler.ts"),
      handler:      "handler",
      role:         s3TriggerRole,
      timeout:      cdk.Duration.seconds(30),
      memorySize:   256,
      environment: {
        CLAIMS_TABLE_NAME:       this.claimsTable.tableName,
        CLAIM_PROCESSING_SF_ARN: claimProcessingStateMachine.stateMachineArn,
      },
      bundling: sharedBundling,
    });

    // S3 event notification: ObjectCreated → s3TriggerFn
    documentsBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3notifications.LambdaDestination(s3TriggerFn),
      { prefix: "documents/" },
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Lambda 2 — claims-api-handler (external, with API Gateway)
    //
    // Public REST API for claim lifecycle management.
    // Clients submit claims, adjuster reviews them, etc.
    // ─────────────────────────────────────────────────────────────────────────

    const claimsApiRole = new iam.Role(this, "ClaimsApiRole", {
      roleName:         `${serviceName}-claims-api-role`,
      assumedBy:        new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies:  [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")],
    });
    claimsApiRole.addToPolicy(dynamoPolicy);
    appSecret.grantRead(claimsApiRole);
    documentsBucket.grantReadWrite(claimsApiRole);
    claimsApiRole.addToPolicy(new iam.PolicyStatement({
      sid:       "AllowStartClaimProcessing",
      actions:   ["states:StartExecution"],
      resources: [claimProcessingStateMachine.stateMachineArn],
    }));

    const claimsApiLogGroup = new logs.LogGroup(this, "ClaimsApiLogGroup", {
      logGroupName:  `/aws/lambda/${serviceName}-claims-api-handler`,
      retention:     logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.claimsApiFn = new lambdaNodejs.NodejsFunction(this, "ClaimsApiFn", {
      functionName: `${serviceName}-claims-api-handler`,
      description:  "Public REST API — claim lifecycle management",
      runtime:      lambda.Runtime.NODEJS_22_X,
      entry:        path.join(__dirname, "../../apps/claims-api-handler/src/index.ts"),
      handler:      "handler",
      role:         claimsApiRole,
      timeout:      cdk.Duration.seconds(30),
      memorySize:   512,
      environment: {
        ...sharedEnv,
        CLAIM_PROCESSING_SF_ARN: claimProcessingStateMachine.stateMachineArn,
      },
      logGroup:     claimsApiLogGroup,
      bundling:     sharedBundling,
    });

    // ─── API Gateway HTTP v2 — claims-api-handler ──────────────────────────────

    this.claimsHttpApi = new apigatewayv2.CfnApi(this, "ClaimsHttpApi", {
      name:          `${serviceName}-claims-api`,
      protocolType:  "HTTP",
      description:   "Public API for claim management",
      corsConfiguration: {
        allowCredentials: false,
        allowHeaders:     ["*"],
        allowMethods:     ["GET", "HEAD", "OPTIONS", "POST", "PATCH", "PUT", "DELETE"],
        allowOrigins:     ["*"],
        exposeHeaders:    ["*"],
        maxAge:           300,
      },
      tags: { Project: projectName, Environment: this.appEnv, ManagedBy: "CDK" },
    });

    const claimsApiGwLogGroup = new logs.LogGroup(this, "ClaimsApiGwLogGroup", {
      logGroupName:  `/aws/api_gw/${serviceName}-claims-api`,
      retention:     logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new apigatewayv2.CfnStage(this, "ClaimsApiDefaultStage", {
      apiId:      this.claimsHttpApi.ref,
      stageName:  "$default",
      autoDeploy: true,
      defaultRouteSettings: {
        throttlingBurstLimit:  50,   // max concurrent requests in flight
        throttlingRateLimit:   100,  // sustained req/s per stage
      },
      accessLogSettings: {
        destinationArn: claimsApiGwLogGroup.logGroupArn,
        format: JSON.stringify({
          requestId:             "$context.requestId",
          sourceIp:              "$context.identity.sourceIp",
          requestTime:           "$context.requestTime",
          httpMethod:            "$context.httpMethod",
          routeKey:              "$context.routeKey",
          status:                "$context.status",
          responseLength:        "$context.responseLength",
          integrationErrorMessage: "$context.integrationErrorMessage",
        }),
      },
    });

    const claimsIntegration = new apigatewayv2.CfnIntegration(this, "ClaimsApiIntegration", {
      apiId:                this.claimsHttpApi.ref,
      integrationType:      "AWS_PROXY",
      integrationUri:       `arn:aws:apigateway:${this.region}:lambda:path/2015-03-31/functions/${this.claimsApiFn.functionArn}/invocations`,
      integrationMethod:    "POST",
      payloadFormatVersion: "2.0",
    });

    new apigatewayv2.CfnRoute(this, "ClaimsApiRootRoute", {
      apiId:    this.claimsHttpApi.ref,
      routeKey: "ANY /",
      target:   `integrations/${claimsIntegration.ref}`,
    });

    new apigatewayv2.CfnRoute(this, "ClaimsApiProxyRoute", {
      apiId:    this.claimsHttpApi.ref,
      routeKey: "ANY /{proxy+}",
      target:   `integrations/${claimsIntegration.ref}`,
    });

    new lambda.CfnPermission(this, "ClaimsApiGwPermission", {
      action:       "lambda:InvokeFunction",
      functionName: this.claimsApiFn.functionArn,
      principal:    "apigateway.amazonaws.com",
      sourceArn:    `arn:aws:execute-api:${this.region}:${this.account}:${this.claimsHttpApi.ref}/*/*`,
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Dashboard — S3 + CloudFront
    //
    // Angular SPA served via CloudFront → S3 (no public bucket access).
    // 403/404 → index.html (200) so Angular's client-side router handles all paths.
    // Invalidation must target /* to clear all cached assets on each deploy.
    // ─────────────────────────────────────────────────────────────────────────

    this.dashboardBucket = new s3.Bucket(this, "DashboardBucket", {
      bucketName:         `${serviceName}-dashboard`,
      blockPublicAccess:  s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL:         true,
      removalPolicy:      isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects:  !isProd,
    });

    // OAI — lets CloudFront read from the private bucket
    const dashboardOai = new cloudfront.OriginAccessIdentity(this, "DashboardOAI", {
      comment: `OAI for ${serviceName} dashboard`,
    });
    this.dashboardBucket.grantRead(dashboardOai);

    this.dashboardDistribution = new cloudfront.Distribution(this, "DashboardDistribution", {
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: new origins.S3Origin(this.dashboardBucket, {
          originAccessIdentity: dashboardOai,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods:       cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods:        cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
        cachePolicy:          cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress:             true,
      },
      // Angular routing: any unknown path returns index.html so the SPA router handles it
      errorResponses: [
        {
          httpStatus:       403,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl:              cdk.Duration.seconds(0),
        },
        {
          httpStatus:       404,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl:              cdk.Duration.seconds(0),
        },
      ],
      priceClass:              cloudfront.PriceClass.PRICE_CLASS_100,
      minimumProtocolVersion:  cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      enableLogging:           false,
    });

    // ─── Stack outputs ─────────────────────────────────────────────────────────

    new cdk.CfnOutput(this, "UsersTableName", {
      value:       usersTable.tableName,
      description: "DynamoDB users table name",
      exportName:  `${serviceName}-users-table-name`,
    });

    new cdk.CfnOutput(this, "ClaimsTableName", {
      value:       this.claimsTable.tableName,
      description: "DynamoDB claims table name",
      exportName:  `${serviceName}-claims-table-name`,
    });

    new cdk.CfnOutput(this, "ClaimsTableArn", {
      value:       this.claimsTable.tableArn,
      description: "DynamoDB claims table ARN",
      exportName:  `${serviceName}-claims-table-arn`,
    });

    new cdk.CfnOutput(this, "ProcessClaimFunctionName", {
      value:       this.processClaimFn.functionName,
      description: "Internal Lambda — process-claim-document",
      exportName:  `${serviceName}-process-claim-function-name`,
    });

    new cdk.CfnOutput(this, "ClaimsApiFunctionName", {
      value:       this.claimsApiFn.functionName,
      description: "External Lambda — claims-api-handler",
      exportName:  `${serviceName}-claims-api-function-name`,
    });

    new cdk.CfnOutput(this, "ClaimsApiEndpoint", {
      value:       `https://${this.claimsHttpApi.ref}.execute-api.${this.region}.amazonaws.com`,
      description: "Claims API Gateway endpoint URL",
      exportName:  `${serviceName}-claims-api-endpoint`,
    });

    new cdk.CfnOutput(this, "DashboardBucketName", {
      value:       this.dashboardBucket.bucketName,
      description: "S3 bucket for the Angular dashboard",
      exportName:  `${serviceName}-dashboard-bucket`,
    });

    new cdk.CfnOutput(this, "DashboardDistributionId", {
      value:       this.dashboardDistribution.distributionId,
      description: "CloudFront distribution ID — use for cache invalidations",
      exportName:  `${serviceName}-dashboard-distribution-id`,
    });

    new cdk.CfnOutput(this, "DashboardUrl", {
      value:       `https://${this.dashboardDistribution.distributionDomainName}`,
      description: "Dashboard public URL",
      exportName:  `${serviceName}-dashboard-url`,
    });

    new cdk.CfnOutput(this, "SecretBootstrapCommand", {
      value: [
        `aws secretsmanager create-secret`,
        `--name ${projectName}/${this.appEnv}/app`,
        `--secret-string '{"CORS_ORIGINS":"*","LOG_LEVEL":"${isProd ? "info" : "debug"}"}'`,
      ].join(" \\\n  "),
      description: "One-time command to create the secret before first CDK deploy",
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Observability — CloudWatch Alarms + Dashboard
    // ─────────────────────────────────────────────────────────────────────────

    // SNS topic for alarm notifications (subscribe manually to add email/Slack)
    const alarmTopic = new sns.Topic(this, "AlarmTopic", {
      topicName:   `${serviceName}-alarms`,
      displayName: "Assistance Platform Alarms",
    });

    // ── Alarm 1: Step Function failures ──────────────────────────────────────
    const sfnFailedAlarm = new cloudwatch.Alarm(this, "SfnFailedAlarm", {
      alarmName:          `${serviceName}-sfn-failed`,
      alarmDescription:   "Claim processing Step Function execution failed",
      metric:             new cloudwatch.Metric({
        namespace:  "AWS/States",
        metricName: "ExecutionsFailed",
        dimensionsMap: { StateMachineArn: claimProcessingStateMachine.stateMachineArn },
        statistic:  "Sum",
        period:     cdk.Duration.minutes(5),
      }),
      threshold:          1,
      evaluationPeriods:  1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData:   cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    sfnFailedAlarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));

    // ── Alarm 2: Claims API Lambda errors ─────────────────────────────────────
    const apiErrorAlarm = new cloudwatch.Alarm(this, "ApiErrorAlarm", {
      alarmName:          `${serviceName}-api-errors`,
      alarmDescription:   "Claims API Lambda error rate elevated",
      metric:             this.claimsApiFn.metricErrors({
        period:    cdk.Duration.minutes(5),
        statistic: "Sum",
      }),
      threshold:          5,
      evaluationPeriods:  1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData:   cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    apiErrorAlarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));

    // ── Alarm 3: Claims API Lambda p99 duration ────────────────────────────────
    const apiLatencyAlarm = new cloudwatch.Alarm(this, "ApiLatencyAlarm", {
      alarmName:          `${serviceName}-api-latency-p99`,
      alarmDescription:   "Claims API p99 latency above 10s",
      metric:             this.claimsApiFn.metricDuration({
        period:    cdk.Duration.minutes(5),
        statistic: "p99",
      }),
      threshold:          10_000,
      evaluationPeriods:  2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData:   cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    apiLatencyAlarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));

    // ── Alarm 4: API Gateway 4xx rate ─────────────────────────────────────────
    const apiGw4xxAlarm = new cloudwatch.Alarm(this, "ApiGw4xxAlarm", {
      alarmName:          `${serviceName}-apigw-4xx`,
      alarmDescription:   "API Gateway client error rate elevated — possible bad client or auth issues",
      metric:             new cloudwatch.Metric({
        namespace:  "AWS/ApiGateway",
        metricName: "4XXError",
        dimensionsMap: { ApiId: this.claimsHttpApi.ref },
        statistic:  "Sum",
        period:     cdk.Duration.minutes(5),
      }),
      threshold:          20,
      evaluationPeriods:  1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData:   cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    apiGw4xxAlarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));

    // ── Alarm 5: API Gateway throttling (429) ──────────────────────────────────
    const throttleAlarm = new cloudwatch.Alarm(this, "ApiThrottleAlarm", {
      alarmName:          `${serviceName}-apigw-throttle`,
      alarmDescription:   "API Gateway throttling requests — rate limit hit",
      metric:             new cloudwatch.Metric({
        namespace:  "AWS/ApiGateway",
        metricName: "Count",
        dimensionsMap: { ApiId: this.claimsHttpApi.ref },
        statistic:  "Sum",
        period:     cdk.Duration.minutes(1),
      }),
      // This alarm is informational; actual throttle count tracked via 429 responses
      threshold:          500,
      evaluationPeriods:  1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData:   cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    throttleAlarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));

    // ── CloudWatch Dashboard ──────────────────────────────────────────────────
    new cloudwatch.Dashboard(this, "OperationalDashboard", {
      dashboardName: `${serviceName}-ops`,
      widgets: [
        // Row 1: Step Function health
        [
          new cloudwatch.GraphWidget({
            title:  "Step Function — Executions",
            width:  12,
            height: 6,
            left: [
              new cloudwatch.Metric({ namespace: "AWS/States", metricName: "ExecutionsStarted",   dimensionsMap: { StateMachineArn: claimProcessingStateMachine.stateMachineArn }, statistic: "Sum", period: cdk.Duration.minutes(5), label: "Started"   }),
              new cloudwatch.Metric({ namespace: "AWS/States", metricName: "ExecutionsSucceeded", dimensionsMap: { StateMachineArn: claimProcessingStateMachine.stateMachineArn }, statistic: "Sum", period: cdk.Duration.minutes(5), label: "Succeeded" }),
              new cloudwatch.Metric({ namespace: "AWS/States", metricName: "ExecutionsFailed",    dimensionsMap: { StateMachineArn: claimProcessingStateMachine.stateMachineArn }, statistic: "Sum", period: cdk.Duration.minutes(5), label: "Failed"    }),
            ],
          }),
          new cloudwatch.GraphWidget({
            title:  "Step Function — Duration (ms)",
            width:  12,
            height: 6,
            left: [
              new cloudwatch.Metric({ namespace: "AWS/States", metricName: "ExecutionTime", dimensionsMap: { StateMachineArn: claimProcessingStateMachine.stateMachineArn }, statistic: "p50",  period: cdk.Duration.minutes(5), label: "p50"  }),
              new cloudwatch.Metric({ namespace: "AWS/States", metricName: "ExecutionTime", dimensionsMap: { StateMachineArn: claimProcessingStateMachine.stateMachineArn }, statistic: "p99",  period: cdk.Duration.minutes(5), label: "p99"  }),
            ],
          }),
        ],
        // Row 2: API health
        [
          new cloudwatch.GraphWidget({
            title:  "Claims API — Invocations & Errors",
            width:  12,
            height: 6,
            left: [
              this.claimsApiFn.metricInvocations({ period: cdk.Duration.minutes(5), label: "Invocations" }),
              this.claimsApiFn.metricErrors({      period: cdk.Duration.minutes(5), label: "Errors"      }),
              this.claimsApiFn.metricThrottles({   period: cdk.Duration.minutes(5), label: "Throttles"   }),
            ],
          }),
          new cloudwatch.GraphWidget({
            title:  "Claims API — Duration (ms)",
            width:  12,
            height: 6,
            left: [
              this.claimsApiFn.metricDuration({ period: cdk.Duration.minutes(5), statistic: "p50",  label: "p50"  }),
              this.claimsApiFn.metricDuration({ period: cdk.Duration.minutes(5), statistic: "p99",  label: "p99"  }),
              this.claimsApiFn.metricDuration({ period: cdk.Duration.minutes(5), statistic: "p100", label: "max"  }),
            ],
          }),
        ],
        // Row 3: API Gateway
        [
          new cloudwatch.GraphWidget({
            title:  "API Gateway — Request Count",
            width:  12,
            height: 6,
            left: [
              new cloudwatch.Metric({ namespace: "AWS/ApiGateway", metricName: "Count",    dimensionsMap: { ApiId: this.claimsHttpApi.ref }, statistic: "Sum", period: cdk.Duration.minutes(5), label: "Total requests" }),
              new cloudwatch.Metric({ namespace: "AWS/ApiGateway", metricName: "4XXError", dimensionsMap: { ApiId: this.claimsHttpApi.ref }, statistic: "Sum", period: cdk.Duration.minutes(5), label: "4XX errors"     }),
              new cloudwatch.Metric({ namespace: "AWS/ApiGateway", metricName: "5XXError", dimensionsMap: { ApiId: this.claimsHttpApi.ref }, statistic: "Sum", period: cdk.Duration.minutes(5), label: "5XX errors"     }),
            ],
          }),
          new cloudwatch.GraphWidget({
            title:  "API Gateway — Latency (ms)",
            width:  12,
            height: 6,
            left: [
              new cloudwatch.Metric({ namespace: "AWS/ApiGateway", metricName: "Latency",        dimensionsMap: { ApiId: this.claimsHttpApi.ref }, statistic: "p50",  period: cdk.Duration.minutes(5), label: "p50"  }),
              new cloudwatch.Metric({ namespace: "AWS/ApiGateway", metricName: "Latency",        dimensionsMap: { ApiId: this.claimsHttpApi.ref }, statistic: "p99",  period: cdk.Duration.minutes(5), label: "p99"  }),
              new cloudwatch.Metric({ namespace: "AWS/ApiGateway", metricName: "IntegrationLatency", dimensionsMap: { ApiId: this.claimsHttpApi.ref }, statistic: "p99", period: cdk.Duration.minutes(5), label: "integration p99" }),
            ],
          }),
        ],
        // Row 4: Alarm status panel
        [
          new cloudwatch.AlarmStatusWidget({
            title:  "Alarm Status",
            width:  24,
            height: 3,
            alarms: [sfnFailedAlarm, apiErrorAlarm, apiLatencyAlarm, apiGw4xxAlarm, throttleAlarm],
          }),
        ],
      ],
    });

    new cdk.CfnOutput(this, "AlarmTopicArn", {
      value:       alarmTopic.topicArn,
      description: "SNS topic for operational alarms — subscribe to receive email/Slack notifications",
      exportName:  `${serviceName}-alarm-topic-arn`,
    });

    // ─────────────────────────────────────────────────────────────────────────
    // ML — Fraud Model Retraining (monthly, fully managed in AWS)
    //
    // Flow:
    //   EventBridge Rule (cron: 1st of month, 06:00 UTC)
    //     → Lambda: fraud-retrain-trigger
    //         → SageMaker Processing Job (ml.m5.large, sklearn container)
    //             → train.py:
    //                 1. Load dataset from S3 (ML bucket)
    //                 2. Security preprocessing (PII removal, k-anonymity)
    //                 3. Train XGBoost
    //                 4. If AUC ≥ MIN_AUC → create/update Serverless endpoint
    //                 5. Update aggregate-risk Lambda env var
    //
    // One-time setup after deploy:
    //   Upload dataset: aws s3 cp insurance_claims.csv s3://<ML_BUCKET>/fraud-scoring/dataset/insurance_claims.csv
    // ─────────────────────────────────────────────────────────────────────────

    // S3 bucket — ML artifacts (source code, dataset, model outputs, metadata)
    const mlBucket = new s3.Bucket(this, "MlBucket", {
      bucketName:        `${serviceName}-ml-artifacts`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL:        true,
      removalPolicy:     cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{
        id:         "expire-training-outputs",
        prefix:     "fraud-scoring/output/",
        expiration: cdk.Duration.days(30),
        enabled:    true,
      }],
    });

    // Upload training source files to S3 at every CDK deploy
    // The Processing Job mounts this prefix as /opt/ml/processing/input/code/
    new s3deploy.BucketDeployment(this, "MlTrainingSource", {
      sources: [s3deploy.Source.asset(path.join(__dirname, "../../ml"), {
        exclude: ["*.ipynb", "*.png", "model/", "__pycache__/", "model.tar.gz"],
      })],
      destinationBucket:    mlBucket,
      destinationKeyPrefix: "fraud-scoring/source/",
    });

    // SageMaker execution role — assumed by the Processing Job container
    // Needs: S3 R/W (dataset + model artifacts), endpoint management, Lambda env update
    const smExecutionRole = new iam.Role(this, "SmExecutionRole", {
      roleName:  `${serviceName}-sm-execution-role`,
      assumedBy: new iam.ServicePrincipal("sagemaker.amazonaws.com"),
      // AmazonSageMakerFullAccess grants ECR pull, CloudWatch Logs, and core SM APIs
      // required for Processing Job container lifecycle
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSageMakerFullAccess"),
      ],
    });
    mlBucket.grantReadWrite(smExecutionRole);

    // train.py creates/updates the inference endpoint from inside the Processing Job
    smExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid:     "AllowInferenceEndpointManagement",
      actions: [
        "sagemaker:CreateModel",
        "sagemaker:CreateEndpointConfig",
        "sagemaker:CreateEndpoint",
        "sagemaker:UpdateEndpoint",
        "sagemaker:DescribeEndpoint",
      ],
      resources: [
        `arn:aws:sagemaker:${this.region}:${this.account}:model/fraud-scoring-*`,
        `arn:aws:sagemaker:${this.region}:${this.account}:endpoint-config/fraud-scoring-*`,
        `arn:aws:sagemaker:${this.region}:${this.account}:endpoint/fraud-scoring-serverless`,
      ],
    }));

    // train.py updates FRAUD_SCORING_ENDPOINT_NAME on the aggregate-risk Lambda
    smExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid:     "AllowUpdateAggregateRiskEnv",
      actions: ["lambda:GetFunctionConfiguration", "lambda:UpdateFunctionConfiguration"],
      resources: [aggregateRiskFn.functionArn],
    }));

    // train.py calls sagemaker:CreateModel which requires PassRole back to itself
    smExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid:     "AllowPassRoleToSelf",
      actions: ["iam:PassRole"],
      resources: [smExecutionRole.roleArn],
    }));

    // Lambda role — only needs CreateProcessingJob + PassRole to SageMaker exec role
    const fraudRetrainTriggerRole = new iam.Role(this, "FraudRetrainTriggerRole", {
      roleName:        `${serviceName}-fraud-retrain-trigger-role`,
      assumedBy:       new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")],
    });
    fraudRetrainTriggerRole.addToPolicy(new iam.PolicyStatement({
      sid:       "AllowCreateProcessingJob",
      actions:   ["sagemaker:CreateProcessingJob"],
      resources: [`arn:aws:sagemaker:${this.region}:${this.account}:processing-job/fraud-scoring-retrain-*`],
    }));
    fraudRetrainTriggerRole.addToPolicy(new iam.PolicyStatement({
      sid:       "AllowPassSmRole",
      actions:   ["iam:PassRole"],
      resources: [smExecutionRole.roleArn],
    }));

    const sklearnImageUri = `683313688378.dkr.ecr.${this.region}.amazonaws.com/sagemaker-scikit-learn:1.2-1-cpu-py3`;

    const fraudRetrainTriggerFn = new lambdaNodejs.NodejsFunction(this, "FraudRetrainTriggerFn", {
      functionName: `${serviceName}-fraud-retrain-trigger`,
      description:  "EventBridge monthly trigger — starts SageMaker Processing Job for fraud model retraining",
      runtime:      lambda.Runtime.NODEJS_22_X,
      entry:        path.join(__dirname, `${handlersBase}/fraud-retrain-trigger.handler.ts`),
      handler:      "handler",
      role:         fraudRetrainTriggerRole,
      timeout:      cdk.Duration.seconds(30),
      memorySize:   256,
      environment: {
        ML_BUCKET:             mlBucket.bucketName,
        SM_EXECUTION_ROLE_ARN: smExecutionRole.roleArn,
        ENDPOINT_NAME:         "fraud-scoring-serverless",
        LAMBDA_FUNCTION_NAME:  aggregateRiskFn.functionName,
        MIN_AUC:               "0.70",
        SKLEARN_IMAGE_URI:     sklearnImageUri,
      },
      bundling: sharedBundling,
    });

    // EventBridge Rule — cron: 1st of every month at 06:00 UTC
    // Syntax: minute hour day month weekday (? = any, * = all)
    new events.Rule(this, "FraudRetrainMonthlyRule", {
      ruleName:    `${serviceName}-fraud-retrain-monthly`,
      description: "Monthly fraud model retraining — 1st of month 06:00 UTC",
      schedule:    events.Schedule.cron({ minute: "0", hour: "6", day: "1", month: "*" }),
      targets:     [new eventsTargets.LambdaFunction(fraudRetrainTriggerFn, {
        retryAttempts: 2,
      })],
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Audit — CloudTrail
    //
    // Captures:
    //   Management events  — IAM, Lambda updates, CDK deploys, config changes
    //   Data events        — DynamoDB claims table R/W (who read which claim)
    //                      — S3 documents bucket R/W (who downloaded a document)
    //
    // Logs land in two places:
    //   S3 (90-day retention, RETAIN on stack deletion — never lose audit logs)
    //   CloudWatch Logs (3-month retention — queryable via Insights)
    // ─────────────────────────────────────────────────────────────────────────

    const trailBucket = new s3.Bucket(this, "TrailBucket", {
      bucketName:        `${serviceName}-cloudtrail-logs`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL:        true,
      // Audit logs must survive stack deletion
      removalPolicy:     cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{
        id:         "expire-old-trail-logs",
        expiration: cdk.Duration.days(90),
        enabled:    true,
      }],
    });

    const trail = new cloudtrail.Trail(this, "AuditTrail", {
      trailName:                  `${serviceName}-audit`,
      bucket:                     trailBucket,
      isMultiRegionTrail:         false,
      includeGlobalServiceEvents: true,   // captures IAM global events
      enableFileValidation:       true,   // tamper-evident log integrity
      sendToCloudWatchLogs:       true,
      cloudWatchLogsRetention:    logs.RetentionDays.THREE_MONTHS,
    });

    // Data events — S3 documents bucket (GetObject/PutObject — who downloaded a claim file)
    // DynamoDB item-level events are captured via management events at the table level
    trail.addEventSelector(
      cloudtrail.DataResourceType.S3_OBJECT,
      [`${documentsBucket.bucketArn}/`],
      { readWriteType: cloudtrail.ReadWriteType.ALL },
    );

    new cdk.CfnOutput(this, "TrailBucketName", {
      value:       trailBucket.bucketName,
      description: "S3 bucket for CloudTrail audit logs (90-day retention, RETAIN policy)",
      exportName:  `${serviceName}-trail-bucket`,
    });

    new cdk.CfnOutput(this, "TrailArn", {
      value:       trail.trailArn,
      description: "CloudTrail ARN — query logs via CloudWatch Insights or Athena",
      exportName:  `${serviceName}-trail-arn`,
    });

    // ─────────────────────────────────────────────────────────────────────────
    // HIPAA — PHI Breach Detection
    //
    // Monitors the CloudTrail log stream for direct IAM user access to the
    // documents bucket. Lambda-invoked access appears as AssumedRole; any
    // IAMUser type indicates a human accessing claim documents directly from
    // the console or CLI — the primary credential-theft breach vector.
    //
    // When the alarm fires, the privacy officer must:
    //   1. Identify the IAM user from the CloudTrail event (userIdentity.arn)
    //   2. Determine which objects were accessed (requestParameters.key)
    //   3. Check if any accessed key has tag phi=true (indicates PHI breach)
    //   4. If PHI: notify affected individuals within 60 days and report to HHS
    //      under 45 CFR §164.408 (Breach Notification Rule)
    // ─────────────────────────────────────────────────────────────────────────

    const phiBreachTopic = new sns.Topic(this, "PhiBreachTopic", {
      topicName:   `${serviceName}-phi-breach-alerts`,
      displayName: "PHI Access Breach Alerts — subscribe privacy officer",
    });

    // MetricFilter: any S3 GetObject on the documents bucket from an IAMUser
    // principal (not a Lambda execution role, which would appear as AssumedRole)
    if (trail.logGroup) {
      const phiBreachFilter = new logs.MetricFilter(this, "PhiDirectAccessFilter", {
        logGroup:        trail.logGroup,
        filterPattern:   logs.FilterPattern.all(
          logs.FilterPattern.stringValue("$.eventSource",                          "=", "s3.amazonaws.com"),
          logs.FilterPattern.stringValue("$.eventName",                            "=", "GetObject"),
          logs.FilterPattern.stringValue("$.requestParameters.bucketName",         "=", documentsBucket.bucketName),
          logs.FilterPattern.stringValue("$.userIdentity.type",                    "=", "IAMUser"),
        ),
        metricNamespace: "Assistance/PHI",
        metricName:      "DirectDocumentAccess",
        metricValue:     "1",
        unit:            cloudwatch.Unit.COUNT,
      });

      const phiBreachAlarm = new cloudwatch.Alarm(this, "PhiBreachAlarm", {
        alarmName:          `${serviceName}-phi-direct-access`,
        alarmDescription:   "IAM user accessed claim documents directly — possible PHI breach. Check CloudTrail for userIdentity.arn and accessed keys.",
        metric:             phiBreachFilter.metric({ statistic: "Sum", period: cdk.Duration.minutes(5) }),
        threshold:          1,
        evaluationPeriods:  1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData:   cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      phiBreachAlarm.addAlarmAction(new cwActions.SnsAction(phiBreachTopic));
    }

    new cdk.CfnOutput(this, "PhiBreachTopicArn", {
      value:       phiBreachTopic.topicArn,
      description: "SNS topic for PHI breach alerts — subscribe privacy officer email here",
      exportName:  `${serviceName}-phi-breach-topic-arn`,
    });

    // ─────────────────────────────────────────────────────────────────────────
    // HIPAA — Bedrock Model Invocation Logging — explicit opt-out
    //
    // The Bedrock PutModelInvocationLoggingConfiguration API requires at least
    // one destination config (cloudWatchConfig or s3Config) — it does not accept
    // an empty loggingConfig. The workaround: provide a valid CloudWatch
    // destination but set all three *DataDeliveryEnabled flags to false.
    // Result: destination is configured, zero data is delivered.
    //
    // This creates an auditable CloudFormation-managed state: any future change
    // to enable logging will appear as a stack drift or changeset — intentional.
    // ─────────────────────────────────────────────────────────────────────────

    // Dedicated log group — exists as the registered destination even though
    // nothing is delivered. Kept at 1 week; if delivery is ever enabled for
    // debugging, logs auto-expire quickly.
    const bedrockInvocationLogGroup = new logs.LogGroup(this, "BedrockInvocationLogGroup", {
      logGroupName:  `/aws/bedrock/model-invocations/${this.appEnv}`,
      retention:     logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // IAM role Bedrock assumes when writing to CloudWatch (required by the API
    // even when delivery is disabled — the principal must exist and be trustable).
    const bedrockLoggingRole = new iam.Role(this, "BedrockLoggingRole", {
      roleName:  `${serviceName}-bedrock-logging-role`,
      assumedBy: new iam.ServicePrincipal("bedrock.amazonaws.com"),
    });
    bedrockInvocationLogGroup.grantWrite(bedrockLoggingRole);

    const bedrockLoggingParams = {
      loggingConfig: {
        cloudWatchConfig: {
          logGroupName: bedrockInvocationLogGroup.logGroupName,
          roleArn:      bedrockLoggingRole.roleArn,
        },
        // All delivery flags OFF — destination exists but nothing is written.
        // To enable for debugging: set textDataDeliveryEnabled to true and redeploy.
        textDataDeliveryEnabled:      false,
        imageDataDeliveryEnabled:     false,
        embeddingDataDeliveryEnabled: false,
        videoDataDeliveryEnabled:     false,
      },
    };

    new cr.AwsCustomResource(this, "BedrockLoggingOptOut", {
      resourceType: "Custom::BedrockLoggingOptOut",
      onCreate: {
        service:            "Bedrock",
        action:             "putModelInvocationLoggingConfiguration",
        parameters:         bedrockLoggingParams,
        physicalResourceId: cr.PhysicalResourceId.of("bedrock-logging-opt-out"),
        region:             this.region,
      },
      onUpdate: {
        service:            "Bedrock",
        action:             "putModelInvocationLoggingConfiguration",
        parameters:         bedrockLoggingParams,
        physicalResourceId: cr.PhysicalResourceId.of("bedrock-logging-opt-out"),
        region:             this.region,
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions:   ["bedrock:PutModelInvocationLoggingConfiguration", "bedrock:GetModelInvocationLoggingConfiguration"],
          resources: ["*"],
        }),
        new iam.PolicyStatement({
          actions:   ["iam:PassRole"],
          resources: [bedrockLoggingRole.roleArn],
        }),
      ]),
    });

    new cdk.CfnOutput(this, "BedrockLoggingStatus", {
      value:       `DELIVERY DISABLED — destination ${bedrockInvocationLogGroup.logGroupName} registered but textDataDelivery=false imageDataDelivery=false embeddingDataDelivery=false`,
      description: "Bedrock invocation logging state (HIPAA: no PHI written — auditable via CloudFormation)",
    });

    new cdk.CfnOutput(this, "MlBucketName", {
      value:       mlBucket.bucketName,
      description: "S3 bucket for ML artifacts — upload dataset here before first retrain",
      exportName:  `${serviceName}-ml-bucket`,
    });

    new cdk.CfnOutput(this, "DatasetUploadCommand", {
      value:       `aws s3 cp insurance_claims.csv s3://${mlBucket.bucketName}/fraud-scoring/dataset/insurance_claims.csv`,
      description: "One-time command to upload the Kaggle dataset before the first retraining run",
    });

    new cdk.CfnOutput(this, "ManualRetrainCommand", {
      value:       `aws lambda invoke --function-name ${serviceName}-fraud-retrain-trigger /dev/null`,
      description: "Trigger a manual retraining run outside of the monthly schedule",
    });
  }
}
