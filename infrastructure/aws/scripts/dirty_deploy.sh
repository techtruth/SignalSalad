#!/usr/bin/env bash
set -euo pipefail

##
## Overall, this is a quick and dirty hack to populate a docker registry and prepare servers to run them.
##   This process should exist in CI/CD in production
##   but exists as is now, for convenience
##

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(cd "${INFRA_DIR}/../.." && pwd)"
COMPOSE_SRC="${ROOT_DIR}/containerization/aws.yml"
cd "$INFRA_DIR"

DOCKER_INSTALL_CMD="sudo apt-get update; sudo apt-get install -y docker.io docker-compose-v2; sudo snap install aws-cli --classic; sudo usermod -aG docker ubuntu;"
TF_OUTPUT_JSON="$(terraform output -json)"

SIGNALING_HOST="$(jq -r '.signaling_public_ip.value' <<<"$TF_OUTPUT_JSON")"
MEDIA_OR_IP="$(jq -r '.media_public_ips.value.north_california[0]' <<<"$TF_OUTPUT_JSON")"
MEDIA_VA_IP="$(jq -r '.media_public_ips.value.north_virginia[0]' <<<"$TF_OUTPUT_JSON")"
ECR_REGISTRY_DOMAIN="$(jq -r '.ecr_registry_domain.value' <<<"$TF_OUTPUT_JSON")"

WEBAPP_REPO="$(jq -r '.ecr_repositories.value.webapp' <<<"$TF_OUTPUT_JSON")"
SIGNALING_REPO="$(jq -r '.ecr_repositories.value.signaling' <<<"$TF_OUTPUT_JSON")"
MEDIA_REPO="$(jq -r '.ecr_repositories.value.media' <<<"$TF_OUTPUT_JSON")"
WEBAPP_IMAGE="${WEBAPP_REPO}:latest"
SIGNALING_IMAGE="${SIGNALING_REPO}:latest"
MEDIA_IMAGE="${MEDIA_REPO}:latest"
AWS_ECR_REGION="${AWS_ECR_REGION:-us-east-2}"
DOCKER_CMD="${DOCKER_CMD:-docker}"

SSH_USER="${SSH_USER:-ubuntu}"
SSH_KEY_FILE="${INFRA_DIR}/.terraform_aws_ssh_key"
REMOTE_BASE_DIR="${REMOTE_BASE_DIR:-~/signalsalad}"
REMOTE_COMPOSE_FILE="${REMOTE_BASE_DIR}/aws.yml"

terraform output -raw ssh_private_key > "$SSH_KEY_FILE"
chmod 600 "$SSH_KEY_FILE"

run_remote() {
  local host="$1"
  shift
  ssh -o StrictHostKeyChecking=accept-new -i "$SSH_KEY_FILE" "${SSH_USER}@${host}" "$@"
}

login_remote_ecr() {
  local host="$1"
  ssh -o StrictHostKeyChecking=accept-new -i "$SSH_KEY_FILE" "${SSH_USER}@${host}" \
    "docker login --username AWS --password-stdin ${ECR_REGISTRY_DOMAIN}" <<<"$ECR_PASSWORD"
}

copy_compose() {
  local host="$1"
  run_remote "$host" "mkdir -p ${REMOTE_BASE_DIR}"
  scp -o StrictHostKeyChecking=accept-new -i "$SSH_KEY_FILE" "$COMPOSE_SRC" "${SSH_USER}@${host}:${REMOTE_COMPOSE_FILE}"
}

# Build docker locally
"$DOCKER_CMD" build -f "${ROOT_DIR}/containerization/Dockerfile.webapp" -t "$WEBAPP_IMAGE" "$ROOT_DIR"
"$DOCKER_CMD" build -f "${ROOT_DIR}/containerization/Dockerfile.signaling" -t "$SIGNALING_IMAGE" "$ROOT_DIR"
"$DOCKER_CMD" build -f "${ROOT_DIR}/containerization/Dockerfile.media" -t "$MEDIA_IMAGE" "$ROOT_DIR"

# Login locally to ECR for pushing.
ECR_PASSWORD="$(aws ecr get-login-password --region "${AWS_ECR_REGION}")"
printf '%s' "$ECR_PASSWORD" | "$DOCKER_CMD" login --username AWS --password-stdin "${ECR_REGISTRY_DOMAIN}"

# Push local docker images to remote registry
"$DOCKER_CMD" push "$WEBAPP_IMAGE"
"$DOCKER_CMD" push "$SIGNALING_IMAGE"
"$DOCKER_CMD" push "$MEDIA_IMAGE"

# Copy compose files in preparation
copy_compose "$SIGNALING_HOST"
copy_compose "$MEDIA_OR_IP"
copy_compose "$MEDIA_VA_IP"

# Install dependencies needed to run docker
run_remote "$SIGNALING_HOST" "$DOCKER_INSTALL_CMD"
run_remote "$MEDIA_OR_IP" "$DOCKER_INSTALL_CMD"
run_remote "$MEDIA_VA_IP" "$DOCKER_INSTALL_CMD"

# Login to ECR on each remote host using locally-fetched token.
login_remote_ecr "$SIGNALING_HOST"
login_remote_ecr "$MEDIA_OR_IP"
login_remote_ecr "$MEDIA_VA_IP"

# Pull image in preparation of future runs
run_remote "$SIGNALING_HOST" "WEBAPP_IMAGE='${WEBAPP_IMAGE}' SIGNALING_IMAGE='${SIGNALING_IMAGE}' MEDIA_IMAGE='${MEDIA_IMAGE}' ANNOUNCED_IP='${SIGNALING_HOST}' REGION='ohio' SIGNALING_HOST='${SIGNALING_HOST}' DOMAIN='${DOMAIN:-}' LETSENCRYPT_EMAIL='${LETSENCRYPT_EMAIL:-}' docker compose -f ${REMOTE_COMPOSE_FILE} pull signaling webapp"
run_remote "$MEDIA_OR_IP"    "WEBAPP_IMAGE='${WEBAPP_IMAGE}' SIGNALING_IMAGE='${SIGNALING_IMAGE}' MEDIA_IMAGE='${MEDIA_IMAGE}' ANNOUNCED_IP='${MEDIA_OR_IP}' REGION='north_california' SIGNALING_HOST='${SIGNALING_HOST}' docker compose -f ${REMOTE_COMPOSE_FILE} pull ingress egress"
run_remote "$MEDIA_VA_IP"    "WEBAPP_IMAGE='${WEBAPP_IMAGE}' SIGNALING_IMAGE='${SIGNALING_IMAGE}' MEDIA_IMAGE='${MEDIA_IMAGE}' ANNOUNCED_IP='${MEDIA_VA_IP}' REGION='north_virginia' SIGNALING_HOST='${SIGNALING_HOST}' docker compose -f ${REMOTE_COMPOSE_FILE} pull ingress egress"

# Success message
echo "Completed successfully!"
