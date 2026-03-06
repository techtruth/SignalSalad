#!/usr/bin/env bash
set -euo pipefail

##
## Quick helper to open plain SSH bash shells to Tencent signaling/media hosts.
## No docker commands are executed.
##

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$INFRA_DIR"

TF_OUTPUT_JSON="$(terraform output -json)"
SIGNALING_HOST="$(jq -r '.signaling_public_ip.value' <<<"$TF_OUTPUT_JSON")"
MEDIA_GZ_IP="$(jq -r '.media_public_ips.value.guangzhou[0]' <<<"$TF_OUTPUT_JSON")"
MEDIA_SH_IP="$(jq -r '.media_public_ips.value.shanghai[0]' <<<"$TF_OUTPUT_JSON")"
MEDIA_VA_IP="$(jq -r '.media_public_ips.value.virginia[0]' <<<"$TF_OUTPUT_JSON")"

SSH_USER="${SSH_USER:-ubuntu}"
SSH_KEY_FILE="${INFRA_DIR}/.terraform_tencent_ssh_key"
RUN_SCREEN_FILE="${INFRA_DIR}/servers.shell.screen"
LOG_DIR="${INFRA_DIR}/screen-logs"

terraform output -raw ssh_private_key > "$SSH_KEY_FILE"
chmod 600 "$SSH_KEY_FILE"
mkdir -p "$LOG_DIR"

cat > "$RUN_SCREEN_FILE" <<EOF2
startup_message off
defscrollback 5000
logfile ${LOG_DIR}/screen-%t.log
deflog on
setenv SIGNALING_HOST ${SIGNALING_HOST}
setenv MEDIA_GZ_IP ${MEDIA_GZ_IP}
setenv MEDIA_SH_IP ${MEDIA_SH_IP}
setenv MEDIA_VA_IP ${MEDIA_VA_IP}
screen -t signaling-shell bash -lc "ssh -tt -o StrictHostKeyChecking=accept-new -i '$SSH_KEY_FILE' ${SSH_USER}@\$SIGNALING_HOST 'exec bash -li'"
screen -t media-gz-shell bash -lc "ssh -tt -o StrictHostKeyChecking=accept-new -i '$SSH_KEY_FILE' ${SSH_USER}@\$MEDIA_GZ_IP 'exec bash -li'"
screen -t media-sh-shell bash -lc "ssh -tt -o StrictHostKeyChecking=accept-new -i '$SSH_KEY_FILE' ${SSH_USER}@\$MEDIA_SH_IP 'exec bash -li'"
screen -t media-va-shell bash -lc "ssh -tt -o StrictHostKeyChecking=accept-new -i '$SSH_KEY_FILE' ${SSH_USER}@\$MEDIA_VA_IP 'exec bash -li'"
select 0
EOF2

echo "screen -S signalsalad-tencent-shell -c $RUN_SCREEN_FILE"
screen -S signalsalad-tencent-shell -c $RUN_SCREEN_FILE
