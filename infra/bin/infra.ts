#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";

import { AssistanceStack } from "../lib/base-stack";
import { SharedResourcesStack } from "../lib/shared-resources-stack";

const app = new cdk.App();

const AWS_ACCOUNT =
  process.env.AWS_ACCOUNT_ID ??
  process.env.CDK_DEFAULT_ACCOUNT ??
  (() => { throw new Error("AWS account not resolved — set AWS_ACCOUNT_ID or configure AWS credentials."); })();
const AWS_REGION = process.env.CDK_DEFAULT_REGION ?? "us-east-1";

new SharedResourcesStack(app, "AssistanceSharedStack", {
  env: { account: AWS_ACCOUNT, region: AWS_REGION },
  description: "Shared resources for the Assistance platform",
});

new AssistanceStack(app, "AssistanceStack-Prod", {
  env: { account: AWS_ACCOUNT, region: AWS_REGION },
  appEnv: "prod",
  description: "Assistance platform — prod environment",
});
