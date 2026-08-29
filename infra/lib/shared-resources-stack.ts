import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

export class SharedResourcesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const projectName = "assistance";

    cdk.Tags.of(this).add("Project", projectName);
    cdk.Tags.of(this).add("Environment", "shared");
    cdk.Tags.of(this).add("ManagedBy", "CDK");

    // ─────────────────────────────────────────────────────────────────────────
    // Shared resources will be added here
    // ─────────────────────────────────────────────────────────────────────────
  }
}
