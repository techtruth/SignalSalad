#!/usr/bin/env bash
set -euo pipefail

##
## Overall, this is a quick and dirty hack to run docker containers on some servers.
##   This process should exist in CI/CD in production
##   but exists as is now, for convenience
##

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$INFRA_DIR"

TF_OUTPUT_JSON="$(terraform output -json)"
SIGNALING_HOST="$(jq -r '.signaling_public_ip.value' <<<"$TF_OUTPUT_JSON")"
OREGON_MEDIA_IP="$(jq -r '.media_public_ips.value.north_california[0]' <<<"$TF_OUTPUT_JSON")"
VIRGINIA_MEDIA_IP="$(jq -r '.media_public_ips.value.north_virginia[0]' <<<"$TF_OUTPUT_JSON")"

WEBAPP_REPO="$(jq -r '.ecr_repositories.value.webapp' <<<"$TF_OUTPUT_JSON")"
SIGNALING_REPO="$(jq -r '.ecr_repositories.value.signaling' <<<"$TF_OUTPUT_JSON")"
MEDIA_REPO="$(jq -r '.ecr_repositories.value.media' <<<"$TF_OUTPUT_JSON")"
WEBAPP_IMAGE="${WEBAPP_REPO}:latest"
SIGNALING_IMAGE="${SIGNALING_REPO}:latest"
MEDIA_IMAGE="${MEDIA_REPO}:latest"

SSH_USER="${SSH_USER:-ubuntu}"
SSH_KEY_FILE="${INFRA_DIR}/.terraform_aws_ssh_key"
RUN_SCREEN_FILE="${INFRA_DIR}/servers.screen"
LOG_DIR="${INFRA_DIR}/screen-logs"

# Write access key to disk
terraform output -raw ssh_private_key > "$SSH_KEY_FILE"
chmod 600 "$SSH_KEY_FILE"
mkdir -p "$LOG_DIR"

# Instructions for screen to run the docker compose files
cat > "$RUN_SCREEN_FILE" <<EOF2
startup_message off
defscrollback 5000
logfile ${LOG_DIR}/screen-%t.log
deflog on
setenv SIGNALING_HOST ${SIGNALING_HOST}
setenv MEDIA_OR_IP ${OREGON_MEDIA_IP}
setenv MEDIA_VA_IP ${VIRGINIA_MEDIA_IP}
setenv WEBAPP_IMAGE ${WEBAPP_IMAGE}
setenv SIGNALING_IMAGE ${SIGNALING_IMAGE}
setenv MEDIA_IMAGE ${MEDIA_IMAGE}
screen -t signaling bash -lc "ssh -o StrictHostKeyChecking=accept-new -i '$SSH_KEY_FILE' ${SSH_USER}@\$SIGNALING_HOST 'ANNOUNCED_IP=\$SIGNALING_HOST REGION=ohio WEBAPP_IMAGE=\$WEBAPP_IMAGE SIGNALING_IMAGE=\$SIGNALING_IMAGE MEDIA_IMAGE=\$MEDIA_IMAGE docker compose -f signalsalad/aws.yml down --remove-orphans && ANNOUNCED_IP=\$SIGNALING_HOST REGION=ohio WEBAPP_IMAGE=\$WEBAPP_IMAGE SIGNALING_IMAGE=\$SIGNALING_IMAGE MEDIA_IMAGE=\$MEDIA_IMAGE docker compose -f signalsalad/aws.yml up signaling webapp'"
screen -t media-or bash -lc "ssh -o StrictHostKeyChecking=accept-new -i '$SSH_KEY_FILE' ${SSH_USER}@\$MEDIA_OR_IP 'ANNOUNCED_IP=\$MEDIA_OR_IP REGION=north_california SIGNALING_HOST=\$SIGNALING_HOST WEBAPP_IMAGE=\$WEBAPP_IMAGE SIGNALING_IMAGE=\$SIGNALING_IMAGE MEDIA_IMAGE=\$MEDIA_IMAGE docker compose -f signalsalad/aws.yml down --remove-orphans && ANNOUNCED_IP=\$MEDIA_OR_IP REGION=north_california SIGNALING_HOST=\$SIGNALING_HOST WEBAPP_IMAGE=\$WEBAPP_IMAGE SIGNALING_IMAGE=\$SIGNALING_IMAGE MEDIA_IMAGE=\$MEDIA_IMAGE docker compose -f signalsalad/aws.yml up ingress egress'"
screen -t media-va bash -lc "ssh -o StrictHostKeyChecking=accept-new -i '$SSH_KEY_FILE' ${SSH_USER}@\$MEDIA_VA_IP 'ANNOUNCED_IP=\$MEDIA_VA_IP REGION=north_virginia SIGNALING_HOST=\$SIGNALING_HOST WEBAPP_IMAGE=\$WEBAPP_IMAGE SIGNALING_IMAGE=\$SIGNALING_IMAGE MEDIA_IMAGE=\$MEDIA_IMAGE docker compose -f signalsalad/aws.yml down --remove-orphans && ANNOUNCED_IP=\$MEDIA_VA_IP REGION=north_virginia SIGNALING_HOST=\$SIGNALING_HOST WEBAPP_IMAGE=\$WEBAPP_IMAGE SIGNALING_IMAGE=\$SIGNALING_IMAGE MEDIA_IMAGE=\$MEDIA_IMAGE docker compose -f signalsalad/aws.yml up ingress egress'"
select 0
EOF2

echo "screen -S signalsalad-aws -c $RUN_SCREEN_FILE"
screen -S signalsalad-aws -c $RUN_SCREEN_FILE
