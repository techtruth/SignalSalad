#!/usr/bin/env bash
set -euo pipefail

echo "dirty_shell.sh is not supported after AWS migration to ECS/Fargate (no SSH hosts)."
echo "Use AWS Console/CloudWatch Logs for task diagnostics."
