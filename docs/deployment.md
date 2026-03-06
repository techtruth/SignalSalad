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

- `aws-deploy` -> provisions all AWS infra in `infrastructure/aws`, including webapp S3 bucket + CloudFront distribution
- `aws-webapp-deploy` builds `webapp/dist`, uploads to AWS S3, and invalidates CloudFront
- `aws-docker-deploy` builds signaling/media Docker images and pushes them to AWS ECR
- `aws-full-deploy` runs all AWS deploy workflows in order: Terraform -> Docker images -> webapp assets
- `tencent-deploy` -> runs Terraform in `infrastructure/tencent`
- `azure-deploy` -> runs Terraform in `infrastructure/azure`

Required GitHub secrets for AWS webapp publish:

- `AWS_WEBAPP_ASSETS_BUCKET`
- `AWS_WEBAPP_CDN_DISTRIBUTION_ID`
- Terraform AWS deploy workflow uses `${{ github.token }}` with `actions: write` permission to update the two secrets above.

Required GitHub secrets for AWS Docker publish:

- `AWS_ECR_SIGNALING_REPOSITORY`
- `AWS_ECR_MEDIA_REPOSITORY`
- Terraform AWS deploy workflow uses `${{ github.token }}` with `actions: write` permission to update the two secrets above.

Workflow files:

- `.github/workflows/aws-terraform-provision.yml`
- `.github/workflows/aws-webapp-cdn-publish.yml`
- `.github/workflows/aws-docker-ecr-publish.yml`
- `.github/workflows/aws-deploy.yml`
- `.github/workflows/terraform-tencent-deploy.yml`
- `.github/workflows/terraform-azure-deploy.yml`

Example tag push:

```bash
git tag aws-deploy
git push origin aws-deploy

git tag aws-webapp-deploy
git push origin aws-webapp-deploy

git tag aws-docker-deploy
git push origin aws-docker-deploy

git tag aws-full-deploy
git push origin aws-full-deploy
```
