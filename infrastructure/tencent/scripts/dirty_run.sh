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
GUANGZHOU_MEDIA_IP="$(jq -r '.media_public_ips.value.guangzhou[0]' <<<"$TF_OUTPUT_JSON")"
SHANGHAI_MEDIA_IP="$(jq -r '.media_public_ips.value.shanghai[0]' <<<"$TF_OUTPUT_JSON")"
VIRGINIA_MEDIA_IP="$(jq -r '.media_public_ips.value.virginia[0]' <<<"$TF_OUTPUT_JSON")"
TCR_REGISTRY_DOMAIN="$(jq -r '.tcr_registry_domain.value' <<<"$TF_OUTPUT_JSON")"
TCR_NAMESPACE="$(jq -r '.tcr_namespace.value' <<<"$TF_OUTPUT_JSON")"
IMAGE_PREFIX="${TCR_REGISTRY_DOMAIN}/${TCR_NAMESPACE}"
WEBAPP_IMAGE="${IMAGE_PREFIX}/webapp:latest"
SIGNALING_IMAGE="${IMAGE_PREFIX}/signaling:latest"
MEDIA_IMAGE="${IMAGE_PREFIX}/media:latest"

SSH_USER="${SSH_USER:-ubuntu}"
SSH_KEY_FILE="${INFRA_DIR}/.terraform_tencent_ssh_key"
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
setenv MEDIA_GZ_IP ${GUANGZHOU_MEDIA_IP}
setenv MEDIA_SH_IP ${SHANGHAI_MEDIA_IP}
setenv MEDIA_VA_IP ${VIRGINIA_MEDIA_IP}
setenv WEBAPP_IMAGE ${WEBAPP_IMAGE}
setenv SIGNALING_IMAGE ${SIGNALING_IMAGE}
setenv MEDIA_IMAGE ${MEDIA_IMAGE}
screen -t signaling bash -lc "ssh -o StrictHostKeyChecking=accept-new -i '$SSH_KEY_FILE' ${SSH_USER}@\$SIGNALING_HOST 'WEBAPP_IMAGE=\$WEBAPP_IMAGE SIGNALING_IMAGE=\$SIGNALING_IMAGE MEDIA_IMAGE=\$MEDIA_IMAGE ANNOUNCED_IP=\$SIGNALING_HOST REGION=siliconvalley DOMAIN=${DOMAIN:-} LETSENCRYPT_EMAIL=${LETSENCRYPT_EMAIL:-} docker compose -f signalsalad/tencent.yml down --remove-orphans && WEBAPP_IMAGE=\$WEBAPP_IMAGE SIGNALING_IMAGE=\$SIGNALING_IMAGE MEDIA_IMAGE=\$MEDIA_IMAGE ANNOUNCED_IP=\$SIGNALING_HOST REGION=siliconvalley DOMAIN=${DOMAIN:-} LETSENCRYPT_EMAIL=${LETSENCRYPT_EMAIL:-} docker compose -f signalsalad/tencent.yml up signaling webapp'"
screen -t media-gz bash -lc "ssh -o StrictHostKeyChecking=accept-new -i '$SSH_KEY_FILE' ${SSH_USER}@\$MEDIA_GZ_IP 'WEBAPP_IMAGE=\$WEBAPP_IMAGE SIGNALING_IMAGE=\$SIGNALING_IMAGE MEDIA_IMAGE=\$MEDIA_IMAGE ANNOUNCED_IP=\$MEDIA_GZ_IP REGION=guangzhou SIGNALING_HOST=\$SIGNALING_HOST docker compose -f signalsalad/tencent.yml down --remove-orphans && WEBAPP_IMAGE=\$WEBAPP_IMAGE SIGNALING_IMAGE=\$SIGNALING_IMAGE MEDIA_IMAGE=\$MEDIA_IMAGE ANNOUNCED_IP=\$MEDIA_GZ_IP REGION=guangzhou SIGNALING_HOST=\$SIGNALING_HOST docker compose -f signalsalad/tencent.yml up ingress egress'"
screen -t media-sh bash -lc "ssh -o StrictHostKeyChecking=accept-new -i '$SSH_KEY_FILE' ${SSH_USER}@\$MEDIA_SH_IP 'WEBAPP_IMAGE=\$WEBAPP_IMAGE SIGNALING_IMAGE=\$SIGNALING_IMAGE MEDIA_IMAGE=\$MEDIA_IMAGE ANNOUNCED_IP=\$MEDIA_SH_IP REGION=shanghai SIGNALING_HOST=\$SIGNALING_HOST docker compose -f signalsalad/tencent.yml down --remove-orphans && WEBAPP_IMAGE=\$WEBAPP_IMAGE SIGNALING_IMAGE=\$SIGNALING_IMAGE MEDIA_IMAGE=\$MEDIA_IMAGE ANNOUNCED_IP=\$MEDIA_SH_IP REGION=shanghai SIGNALING_HOST=\$SIGNALING_HOST docker compose -f signalsalad/tencent.yml up ingress egress'"
screen -t media-va bash -lc "ssh -o StrictHostKeyChecking=accept-new -i '$SSH_KEY_FILE' ${SSH_USER}@\$MEDIA_VA_IP 'WEBAPP_IMAGE=\$WEBAPP_IMAGE SIGNALING_IMAGE=\$SIGNALING_IMAGE MEDIA_IMAGE=\$MEDIA_IMAGE ANNOUNCED_IP=\$MEDIA_VA_IP REGION=virginia SIGNALING_HOST=\$SIGNALING_HOST docker compose -f signalsalad/tencent.yml down --remove-orphans && WEBAPP_IMAGE=\$WEBAPP_IMAGE SIGNALING_IMAGE=\$SIGNALING_IMAGE MEDIA_IMAGE=\$MEDIA_IMAGE ANNOUNCED_IP=\$MEDIA_VA_IP REGION=virginia SIGNALING_HOST=\$SIGNALING_HOST docker compose -f signalsalad/tencent.yml up ingress egress'"
select 0
EOF2

echo "screen -S signalsalad-tencent -c $RUN_SCREEN_FILE"
screen -S signalsalad-tencent -c $RUN_SCREEN_FILE
