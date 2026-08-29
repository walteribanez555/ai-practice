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
});
