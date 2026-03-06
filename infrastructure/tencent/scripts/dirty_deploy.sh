#!/usr/bin/env bash
set -euo pipefail

##
## Overall, this is a quick and dirty hack to populate a docker registry and prepare servers to run them.
##   This process should exist in CI/CD in production
##   but exists as is now, for convenience
##

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 '<docker-login-command>'"
  echo "Example: $0 'docker login -u <user> -p <token> <registry>'"
  exit 1
fi

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(cd "${INFRA_DIR}/../.." && pwd)"
COMPOSE_SRC="${ROOT_DIR}/containerization/tencent.yml"
cd "$INFRA_DIR"

DOCKER_INSTALL_CMD="sudo apt-get update; sudo apt-get install -y docker.io docker-compose-v2; sudo usermod -aG docker ubuntu;"
DOCKER_LOGIN_CMD="$1"
TF_OUTPUT_JSON="$(terraform output -json)"

SIGNALING_HOST="$(jq -r '.signaling_public_ip.value' <<<"$TF_OUTPUT_JSON")"
MEDIA_GZ_IP="$(jq -r '.media_public_ips.value.guangzhou[0]' <<<"$TF_OUTPUT_JSON")"
MEDIA_SH_IP="$(jq -r '.media_public_ips.value.shanghai[0]' <<<"$TF_OUTPUT_JSON")"
MEDIA_VA_IP="$(jq -r '.media_public_ips.value.virginia[0]' <<<"$TF_OUTPUT_JSON")"
TCR_REGISTRY_DOMAIN="$(jq -r '.tcr_registry_domain.value' <<<"$TF_OUTPUT_JSON")"
TCR_NAMESPACE="$(jq -r '.tcr_namespace.value' <<<"$TF_OUTPUT_JSON")"
IMAGE_PREFIX="${TCR_REGISTRY_DOMAIN}/${TCR_NAMESPACE}"
WEBAPP_IMAGE="${IMAGE_PREFIX}/webapp:latest"
SIGNALING_IMAGE="${IMAGE_PREFIX}/signaling:latest"
MEDIA_IMAGE="${IMAGE_PREFIX}/media:latest"

SSH_USER="${SSH_USER:-ubuntu}"
SSH_KEY_FILE="${INFRA_DIR}/.terraform_tencent_ssh_key"
REMOTE_BASE_DIR="${REMOTE_BASE_DIR:-~/signalsalad}"
REMOTE_COMPOSE_FILE="${REMOTE_BASE_DIR}/tencent.yml"
DOCKER_CMD="${DOCKER_CMD:-docker}"
DOCKER_PLATFORM="${DOCKER_PLATFORM:-linux/amd64}"

run_remote() {
  local host="$1"
  shift
  ssh -o StrictHostKeyChecking=accept-new -i "$SSH_KEY_FILE" "${SSH_USER}@${host}" "$@"
}

copy_compose() {
  local host="$1"
  run_remote "$host" "mkdir -p ${REMOTE_BASE_DIR}"
  scp -o StrictHostKeyChecking=accept-new -i "$SSH_KEY_FILE" "$COMPOSE_SRC" "${SSH_USER}@${host}:${REMOTE_COMPOSE_FILE}"
}

# Write access key to disk
terraform output -raw ssh_private_key > "$SSH_KEY_FILE"
chmod 600 "$SSH_KEY_FILE"

# Require buildx for cross-arch builds.
if ! "$DOCKER_CMD" buildx version >/dev/null 2>&1; then
  echo "ERROR: docker buildx is required to build ${DOCKER_PLATFORM} images."
  exit 1
fi

# Build docker images locally as linux/amd64 regardless of host arch.
"$DOCKER_CMD" buildx build --platform "$DOCKER_PLATFORM" --load -f "${ROOT_DIR}/containerization/Dockerfile.webapp" -t "$WEBAPP_IMAGE" "$ROOT_DIR"
"$DOCKER_CMD" buildx build --platform "$DOCKER_PLATFORM" --load -f "${ROOT_DIR}/containerization/Dockerfile.signaling" -t "$SIGNALING_IMAGE" "$ROOT_DIR"
"$DOCKER_CMD" buildx build --platform "$DOCKER_PLATFORM" --load -f "${ROOT_DIR}/containerization/Dockerfile.media" -t "$MEDIA_IMAGE" "$ROOT_DIR"

# Login locally to TCR for pushing.
bash -lc "$DOCKER_LOGIN_CMD"

# Push local docker images to remote registry
"$DOCKER_CMD" push "$WEBAPP_IMAGE"
"$DOCKER_CMD" push "$SIGNALING_IMAGE"
"$DOCKER_CMD" push "$MEDIA_IMAGE"

# Copy compose files in preparation
copy_compose "$SIGNALING_HOST"
copy_compose "$MEDIA_GZ_IP"
copy_compose "$MEDIA_SH_IP"
copy_compose "$MEDIA_VA_IP"

# Install dependencies needed to run docker
run_remote "$SIGNALING_HOST" "$DOCKER_INSTALL_CMD"
run_remote "$MEDIA_GZ_IP" "$DOCKER_INSTALL_CMD"
run_remote "$MEDIA_SH_IP" "$DOCKER_INSTALL_CMD"
run_remote "$MEDIA_VA_IP" "$DOCKER_INSTALL_CMD"

# Login to TCR and pull images on each remote host.
run_remote "$SIGNALING_HOST" "$DOCKER_LOGIN_CMD; WEBAPP_IMAGE='${WEBAPP_IMAGE}' SIGNALING_IMAGE='${SIGNALING_IMAGE}' MEDIA_IMAGE='${MEDIA_IMAGE}' DOMAIN='${DOMAIN:-}' LETSENCRYPT_EMAIL='${LETSENCRYPT_EMAIL:-}' docker compose -f ${REMOTE_COMPOSE_FILE} pull signaling webapp"
run_remote "$MEDIA_GZ_IP" "$DOCKER_LOGIN_CMD; WEBAPP_IMAGE='${WEBAPP_IMAGE}' SIGNALING_IMAGE='${SIGNALING_IMAGE}' MEDIA_IMAGE='${MEDIA_IMAGE}' SIGNALING_HOST='${SIGNALING_HOST}' docker compose -f ${REMOTE_COMPOSE_FILE} pull ingress egress"
run_remote "$MEDIA_SH_IP" "$DOCKER_LOGIN_CMD; WEBAPP_IMAGE='${WEBAPP_IMAGE}' SIGNALING_IMAGE='${SIGNALING_IMAGE}' MEDIA_IMAGE='${MEDIA_IMAGE}' SIGNALING_HOST='${SIGNALING_HOST}' docker compose -f ${REMOTE_COMPOSE_FILE} pull ingress egress"
run_remote "$MEDIA_VA_IP" "$DOCKER_LOGIN_CMD; WEBAPP_IMAGE='${WEBAPP_IMAGE}' SIGNALING_IMAGE='${SIGNALING_IMAGE}' MEDIA_IMAGE='${MEDIA_IMAGE}' SIGNALING_HOST='${SIGNALING_HOST}' docker compose -f ${REMOTE_COMPOSE_FILE} pull ingress egress"

# Success message
echo "Completed successfully!"
