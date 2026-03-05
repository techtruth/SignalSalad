# AWS Terraform Stack

This is the AWS Terraform entrypoint for SignalSalad infrastructure.

## What it deploys

- Signaling ECS/Fargate service in Ohio (`us-east-2`) behind a public NLB
- Media ingress/egress ECS/Fargate services in North California (`us-west-1`) and North Virginia (`us-east-1`)
- Per-region default VPC/default subnet usage with dedicated security groups
- ECR repositories for `webapp`, `signaling`, and `media`
- S3 + CloudFront static hosting for webapp assets (`webapp_url`)

## Prerequisites

- Terraform >= 1.5
- AWS credentials in environment/profile (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optional `AWS_SESSION_TOKEN`)

## Usage

```bash
cd infrastructure/aws
terraform init
terraform plan
terraform apply
```

To tear down:

```bash
terraform destroy
```

## Notes

- Deployment helper scripts are available under `infrastructure/aws/scripts/`.
- ECS services default to `desired_count = 0` and are intended to be started on demand for demo usage.
- `POST /demo/start` is exposed through CloudFront and scales signaling/media ECS services to `1`.
- `GET /demo/status` is exposed through CloudFront and reports startup readiness; once stable, it schedules auto-scale back to `0` after `demo_server_warm_minutes` (default `15`).
- ECR repositories are created with `force_delete` enabled by default so `terraform destroy` can remove them even if images still exist (`ecr_force_delete = true`).
- CIDRs are not configured in this project. Networking uses each region's AWS default VPC and default subnet.
- Webapp static assets are served via CloudFront with an S3 origin and websocket paths (`/signaling*`, `/status*`) proxied to the signaling host.
- Optional: Terraform can sync `AWS_WEBAPP_ASSETS_BUCKET` and `AWS_WEBAPP_CDN_DISTRIBUTION_ID` GitHub Actions secrets when `manage_github_actions_secrets = true` and `GITHUB_TOKEN` is provided.
- Optional: Terraform can also sync `AWS_ECR_SIGNALING_REPOSITORY` and `AWS_ECR_MEDIA_REPOSITORY` GitHub Actions secrets for Docker image publish workflows.

## Webapp Upload (S3 + CDN)

After `terraform apply`, publish `webapp/dist`:

```bash
WEBAPP_BUCKET="$(terraform output -raw webapp_assets_bucket_name)"
WEBAPP_CDN_ID="$(terraform output -raw webapp_cdn_distribution_id)"

# Build production bundle
cd ../../webapp
npm ci
node server.js --mode production

# Sync static assets
aws s3 sync dist "s3://${WEBAPP_BUCKET}" --delete --exclude "index.html"
aws s3 cp dist/index.html "s3://${WEBAPP_BUCKET}/index.html" \
  --cache-control "no-cache, no-store, must-revalidate" \
  --content-type "text/html; charset=utf-8"

# Refresh edge cache
aws cloudfront create-invalidation --distribution-id "${WEBAPP_CDN_ID}" --paths "/*"
```

## Docker Image Publish (ECR)

After `terraform apply`, build and push signaling/media images:

```bash
TF_OUTPUT_JSON="$(terraform output -json)"
SIGNALING_REPO="$(jq -r '.ecr_repositories.value.signaling' <<<"${TF_OUTPUT_JSON}")"
MEDIA_REPO="$(jq -r '.ecr_repositories.value.media' <<<"${TF_OUTPUT_JSON}")"
ECR_REGISTRY="$(terraform output -raw ecr_registry_domain)"
AWS_ECR_REGION="$(echo "${ECR_REGISTRY}" | cut -d'.' -f4)"

aws ecr get-login-password --region "${AWS_ECR_REGION}" | docker login --username AWS --password-stdin "${ECR_REGISTRY}"

docker build -f ../../containerization/Dockerfile.signaling -t "${SIGNALING_REPO}:latest" ../../
docker build -f ../../containerization/Dockerfile.media -t "${MEDIA_REPO}:latest" ../../

docker push "${SIGNALING_REPO}:latest"
docker push "${MEDIA_REPO}:latest"
```

## Helper Scripts

Use the helper script to build/push images and force ECS service redeploy:

```bash
cd infrastructure/aws

# Build/push images and trigger ECS force-new-deployment
./scripts/dirty_deploy.sh
```

`dirty_run.sh` and `dirty_shell.sh` are retained as compatibility stubs and are not used with ECS/Fargate.
