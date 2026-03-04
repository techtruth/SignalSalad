# AWS Terraform Stack

This is the AWS Terraform entrypoint for SignalSalad infrastructure.

## What it deploys

- Signaling node in Ohio (`us-east-2`)
- Media nodes in North California (`us-west-1`) and North Virginia (`us-east-1`)
- Per-region VPC/subnet/route/security-group setup
- Shared SSH keypair registration
- ECR repositories for `webapp`, `signaling`, and `media`

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
- ECR repositories are created with `force_delete` enabled by default so `terraform destroy` can remove them even if images still exist (`ecr_force_delete = true`).
- Media nodes are pinned to `t3.small` (`media_instance_type`) to keep them on 2 vCPU with minimal RAM.

## Compose Deployment Helpers

Use the helper scripts to build/push images and run compose across signaling/media hosts:

```bash
cd infrastructure/aws

# Build/push images and pre-pull on hosts
./scripts/dirty_deploy.sh

# Generate a screen config and launch signaling/media compose on each server
./scripts/dirty_run.sh

# Optional: open SSH shells to signaling/media hosts
./scripts/dirty_shell.sh
```
