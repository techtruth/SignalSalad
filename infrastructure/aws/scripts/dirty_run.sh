#!/usr/bin/env bash
set -euo pipefail

echo "dirty_run.sh is not supported after AWS migration to ECS/Fargate."
echo "Use infrastructure/aws/scripts/dirty_deploy.sh to push images and trigger ECS service redeploys."
