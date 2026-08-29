import * as cdk from "aws-cdk-lib";
import { IConstruct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";

export class SecurityValidationAspect implements cdk.IAspect {
  constructor(private readonly environment: string) {}

  visit(node: IConstruct): void {
    if (node instanceof rds.DatabaseInstance || node instanceof rds.CfnDBInstance) {
      this.validateRdsInstance(node);
    }

    if (node instanceof ec2.SecurityGroup || node instanceof ec2.CfnSecurityGroup) {
      this.validateSecurityGroup(node);
    }

    if (node instanceof iam.Policy || node instanceof iam.CfnPolicy) {
      this.validateIamPolicy(node);
    }
  }

  private validateRdsInstance(node: IConstruct): void {
    if (node instanceof rds.CfnDBInstance) {
      if (!node.storageEncrypted) {
        cdk.Annotations.of(node).addError("RDS instance must have storage encryption enabled");
      }
      if (this.environment === "prod" && !node.deletionProtection) {
        cdk.Annotations.of(node).addWarning(
          "Production RDS instance should have deletion protection enabled"
        );
      }
    }
  }

  private validateSecurityGroup(node: IConstruct): void {
    if (node instanceof ec2.CfnSecurityGroup) {
      if (!node.groupDescription || node.groupDescription.length < 10) {
        cdk.Annotations.of(node).addWarning(
          "Security group should have a meaningful description"
        );
      }

      const ingress = node.securityGroupIngress;
      if (ingress && Array.isArray(ingress)) {
        ingress.forEach((rule: any) => {
          if (rule.cidrIp === "0.0.0.0/0" && rule.ipProtocol === "-1") {
            cdk.Annotations.of(node).addError(
              "Security group has overly permissive ingress rule (0.0.0.0/0 with all protocols)"
            );
          }
        });
      }
    }
  }

  private validateIamPolicy(node: IConstruct): void {
    if (node instanceof iam.CfnPolicy) {
      const policyDoc = node.policyDocument as any;
      if (policyDoc && policyDoc.Statement) {
        policyDoc.Statement.forEach((statement: any) => {
          if (
            statement.Effect === "Allow" &&
            statement.Action === "*" &&
            statement.Resource === "*"
          ) {
            cdk.Annotations.of(node).addError(
              "IAM policy has overly permissive statement (Allow * on *)"
            );
          }
        });
      }
    }
  }
}

export class CostOptimizationAspect implements cdk.IAspect {
  constructor(private readonly environment: string) {}

  visit(node: IConstruct): void {
    if (node instanceof ecs.CfnService) {
      this.validateEcsService(node);
    }

    if (node instanceof rds.CfnDBInstance) {
      this.validateRdsCost(node);
    }

    if (node instanceof ec2.CfnNatGateway) {
      this.validateNatGateway(node);
    }
  }

  private validateEcsService(node: ecs.CfnService): void {
    if (this.environment === "dev" && node.desiredCount && node.desiredCount > 2) {
      cdk.Annotations.of(node).addWarning(
        `ECS service has ${node.desiredCount} desired tasks in dev. Consider reducing to save costs.`
      );
    }
  }

  private validateRdsCost(node: rds.CfnDBInstance): void {
    if (this.environment === "dev") {
      const instanceClass = node.dbInstanceClass;
      if (
        instanceClass &&
        !instanceClass.includes("t3.micro") &&
        !instanceClass.includes("t4g.micro")
      ) {
        cdk.Annotations.of(node).addWarning(
          `RDS instance is using ${instanceClass} in dev. Consider t3.micro or t4g.micro to reduce costs.`
        );
      }

      if (node.multiAz) {
        cdk.Annotations.of(node).addWarning(
          "Multi-AZ is enabled for dev RDS instance — this doubles the cost."
        );
      }
    }
  }

  private validateNatGateway(node: ec2.CfnNatGateway): void {
    if (this.environment === "dev") {
      cdk.Annotations.of(node).addInfo(
        "NAT Gateway costs ~$45/month. Consider a single NAT instance in dev."
      );
    }
  }
}
