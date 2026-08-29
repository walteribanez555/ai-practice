import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AssistanceStack } from "../lib/base-stack";
import { SharedResourcesStack } from "../lib/shared-resources-stack";

const AWS_ACCOUNT = "123456789012";
const AWS_REGION = "us-east-1";
const ENV = { account: AWS_ACCOUNT, region: AWS_REGION };

describe("SharedResourcesStack", () => {
  it("synthesises without errors", () => {
    const app = new cdk.App();
    const stack = new SharedResourcesStack(app, "TestSharedStack", { env: ENV });
    const template = Template.fromStack(stack);
    expect(template).toBeDefined();
  });
});

describe("AssistanceStack", () => {
  it("synthesises without errors", () => {
    const app = new cdk.App();
    const stack = new AssistanceStack(app, "TestProdStack", {
      env: ENV,
      appEnv: "prod",
    });
    const template = Template.fromStack(stack);
    expect(template).toBeDefined();
  });

  it("exposes appEnv", () => {
    const app = new cdk.App();
    const stack = new AssistanceStack(app, "TestTagStack", {
      env: ENV,
      appEnv: "prod",
    });
    expect(stack.appEnv).toBe("prod");
  });

  it("creates the claims DynamoDB table", () => {
    const app = new cdk.App();
    const stack = new AssistanceStack(app, "TestDynamoStack", {
      env: ENV,
      appEnv: "prod",
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "assistance-prod-claims",
      KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    });
  });

  it("creates GSIs for clientId, status and prioridad", () => {
    const app = new cdk.App();
    const stack = new AssistanceStack(app, "TestGsiStack", {
      env: ENV,
      appEnv: "prod",
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties("AWS::DynamoDB::Table", {
      GlobalSecondaryIndexes: [
        { IndexName: "clientId-createdAt-index" },
        { IndexName: "status-createdAt-index" },
        { IndexName: "priority-createdAt-index" },
      ],
    });
  });
});
