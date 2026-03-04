# Tencent Terraform Stack

This is the Tencent Terraform entrypoint for SignalSalad infrastructure.

## What it deploys

- Signaling node in Silicon Valley
- Media nodes in Guangzhou, Shanghai, and Virginia
- Per-region VPC/subnet/security groups
- Shared SSH keypair registration
- Tencent TCR instance/namespace/repositories for `webapp`, `signaling`, and `media`

## Prerequisites

- Terraform >= 1.5
- `TENCENTCLOUD_SECRET_ID`
- `TENCENTCLOUD_SECRET_KEY`

## Usage

```bash
cd infrastructure/tencent
terraform init
terraform plan
terraform apply
```

To tear down:

```bash
terraform destroy
```

## Notes

- Deployment helper scripts are available under `infrastructure/tencent/scripts/`
- Compose deployment helpers:
  - `scripts/dirty_deploy.sh "<docker-login-command>"`
  - `scripts/dirty_run.sh`
  - `scripts/dirty_shell.sh`
