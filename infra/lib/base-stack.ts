import * as cdk from "aws-cdk-lib";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
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
      pointInTimeRecovery: isProd,
      removalPolicy:       isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
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

    // ─── Shared DynamoDB policy ────────────────────────────────────────────────

    const dynamoPolicy = new iam.PolicyStatement({
      sid:     "AllowClaimsTableAccess",
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
      ],
    });

    // ─── Shared Lambda environment ─────────────────────────────────────────────
    // Sensitive values (CORS_ORIGINS, LOG_LEVEL, …) are NOT injected here.
    // Each Lambda fetches them at cold start via APP_SECRET_ARN → Secrets Manager.

    const sharedEnv = {
      NODE_ENV:          isProd ? "production" : "development",
      CLAIMS_TABLE_NAME: this.claimsTable.tableName,
      APP_SECRET_ARN:    appSecret.secretArn,
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
      timeout:      cdk.Duration.seconds(30),
      memorySize:   512,
      environment:  sharedEnv,
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

    // ─── Stack outputs ─────────────────────────────────────────────────────────

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
