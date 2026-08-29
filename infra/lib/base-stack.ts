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
          id:         "expire-documents",
          expiration: cdk.Duration.days(7),
          enabled:    true,
        },
      ],
      cors: [
        {
          // Browsers need to PUT directly via presigned URL
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: ["*"],
          allowedHeaders: ["content-type", "content-length"],
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
    processClaimRole.addToPolicy(new iam.PolicyStatement({
      sid:     "AllowBedrockInvoke",
      actions: ["bedrock:InvokeModel"],
      resources: [
        `arn:aws:bedrock:${this.region}::foundation-model/*`,
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/*`,
      ],
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
        // Override via env var to switch models without a redeploy
        BEDROCK_MODEL_ID: process.env.BEDROCK_MODEL_ID ?? "us.amazon.nova-pro-v1:0",
      },
      logGroup:     processClaimLogGroup,
      bundling:     sharedBundling,
    });

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
      environment: sharedEnv,
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
  }
}
