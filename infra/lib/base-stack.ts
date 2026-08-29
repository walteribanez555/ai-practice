import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

export interface AssistanceStackProps extends cdk.StackProps {
  appEnv: string;
  serviceName?: string;
}

export class AssistanceStack extends cdk.Stack {
  public readonly appEnv: string;

  constructor(scope: Construct, id: string, props: AssistanceStackProps) {
    super(scope, id, props);

    this.appEnv = props.appEnv;

    const projectName = "assistance";

    cdk.Tags.of(this).add("Project", projectName);
    cdk.Tags.of(this).add("Environment", this.appEnv);
    cdk.Tags.of(this).add("ManagedBy", "CDK");

    // ─────────────────────────────────────────────────────────────────────────
    // Services will be added here
    // ─────────────────────────────────────────────────────────────────────────
  }
}
