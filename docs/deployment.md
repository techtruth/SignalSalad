# Deployment Guide

SignalSalad infrastructure is provider-isolated.

## Terraform Entrypoints

Use these folders as the only Terraform entrypoints.

- `infrastructure/tencent`
- `infrastructure/aws`
- `infrastructure/azure`

## Tencent Deployment (Current Path)

1. Enter provider folder.

```bash
cd infrastructure/tencent
```

2. Export credentials.

```bash
export TENCENTCLOUD_SECRET_ID="..."
export TENCENTCLOUD_SECRET_KEY="..."
```

3. Initialize, plan, apply.

```bash
terraform init
terraform plan
terraform apply
```

4. Optional: fetch the shared private key output.

```bash
terraform output -raw ssh_private_key
```

5. Tear down when needed.

```bash
terraform destroy
```

## Provider-Specific Docs

- [Tencent](../infrastructure/tencent/README.md)
- [AWS](../infrastructure/aws/README.md)
- [Azure](../infrastructure/azure/README.md)

## GitHub Actions Tag Deploys

Terraform deploys can be triggered by pushing one of these tags:

- `aws-deploy` -> runs Terraform in `infrastructure/aws`
- `tencent-deploy` -> runs Terraform in `infrastructure/tencent`
- `azure-deploy` -> runs Terraform in `infrastructure/azure`

Workflow files:

- `.github/workflows/terraform-aws-deploy.yml`
- `.github/workflows/terraform-tencent-deploy.yml`
- `.github/workflows/terraform-azure-deploy.yml`

Example tag push:

```bash
git tag aws-deploy
git push origin aws-deploy
```
