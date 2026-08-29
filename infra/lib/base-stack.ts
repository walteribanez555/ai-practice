import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

export interface AssistanceStackProps extends cdk.StackProps {
  appEnv: string;
  serviceName?: string;
}

export class AssistanceStack extends cdk.Stack {
  public readonly appEnv: string;
  public readonly claimsTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: AssistanceStackProps) {
    super(scope, id, props);

    this.appEnv = props.appEnv;

    const projectName = "assistance";
    const serviceName = props.serviceName ?? `${projectName}-${this.appEnv}`;
    const isProd = this.appEnv === "prod";

    cdk.Tags.of(this).add("Project", projectName);
    cdk.Tags.of(this).add("Environment", this.appEnv);
    cdk.Tags.of(this).add("ManagedBy", "CDK");

    // ─────────────────────────────────────────────────────────────────────────
    // DynamoDB — claims table
    //
    // Access patterns:
    //   1. Get claim by ID              → PK id
    //   2. List claims by client        → GSI clientId-createdAt
    //   3. List claims by status        → GSI status-createdAt  (admin dashboard)
    //   4. Recent claims by client      → GSI clientId-createdAt + filter
    // ─────────────────────────────────────────────────────────────────────────
    this.claimsTable = new dynamodb.Table(this, "ClaimsTable", {
      tableName:    `${serviceName}-claims`,
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },

      billingMode: isProd
        ? dynamodb.BillingMode.PAY_PER_REQUEST
        : dynamodb.BillingMode.PROVISIONED,
      readCapacity:  isProd ? undefined : 5,
      writeCapacity: isProd ? undefined : 5,

      encryption: dynamodb.TableEncryption.AWS_MANAGED,

      pointInTimeRecovery: isProd,

      removalPolicy: isProd
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,

      timeToLiveAttribute: "ttl",
    });

    // GSI 1 — query by clientId sorted by creation date
    // Usage: findByClientId, findRecentByClientId (fraud scoring)
    this.claimsTable.addGlobalSecondaryIndex({
      indexName:    "clientId-createdAt-index",
      partitionKey: { name: "clientId",  type: dynamodb.AttributeType.STRING },
      sortKey:      { name: "createdAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI 2 — query by status sorted by creation date
    // Usage: admin dashboard — list pending / processing / error claims
    this.claimsTable.addGlobalSecondaryIndex({
      indexName:    "status-createdAt-index",
      partitionKey: { name: "status",    type: dynamodb.AttributeType.STRING },
      sortKey:      { name: "createdAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI 3 — query by prioridad sorted by creation date
    // Usage: adjuster queue — claims by priority level
    this.claimsTable.addGlobalSecondaryIndex({
      indexName:    "prioridad-createdAt-index",
      partitionKey: { name: "prioridad", type: dynamodb.AttributeType.STRING },
      sortKey:      { name: "createdAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Stack outputs
    // ─────────────────────────────────────────────────────────────────────────
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
  }
}
