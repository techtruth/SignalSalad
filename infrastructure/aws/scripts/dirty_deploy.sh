#!/usr/bin/env bash
set -euo pipefail

# Quick helper for local AWS deploy iteration:
# 1) Build and push signaling/media images to ECR
# 2) Force ECS services to pull latest tags

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(cd "${INFRA_DIR}/../.." && pwd)"
cd "$INFRA_DIR"

DOCKER_CMD="${DOCKER_CMD:-docker}"
TF_OUTPUT_JSON="$(terraform output -json)"

SIGNALING_REPO="$(jq -r '.ecr_repositories.value.signaling' <<<"$TF_OUTPUT_JSON")"
MEDIA_REPO="$(jq -r '.ecr_repositories.value.media' <<<"$TF_OUTPUT_JSON")"
ECR_REGISTRY_DOMAIN="$(jq -r '.ecr_registry_domain.value' <<<"$TF_OUTPUT_JSON")"
AWS_ECR_REGION="${AWS_ECR_REGION:-$(cut -d'.' -f4 <<<"$ECR_REGISTRY_DOMAIN")}" 

SIGNALING_IMAGE="${SIGNALING_REPO}:latest"
MEDIA_IMAGE="${MEDIA_REPO}:latest"

# Build and push local images.
"$DOCKER_CMD" build -f "${ROOT_DIR}/containerization/Dockerfile.signaling" -t "$SIGNALING_IMAGE" "$ROOT_DIR"
"$DOCKER_CMD" build -f "${ROOT_DIR}/containerization/Dockerfile.media" -t "$MEDIA_IMAGE" "$ROOT_DIR"

ECR_PASSWORD="$(aws ecr get-login-password --region "${AWS_ECR_REGION}")"
printf '%s' "$ECR_PASSWORD" | "$DOCKER_CMD" login --username AWS --password-stdin "${ECR_REGISTRY_DOMAIN}"

"$DOCKER_CMD" push "$SIGNALING_IMAGE"
"$DOCKER_CMD" push "$MEDIA_IMAGE"

force_deploy_service() {
  local cluster="$1"
  local service="$2"
  local region="$3"

  if [[ -z "$cluster" || "$cluster" == "null" || -z "$service" || "$service" == "null" ]]; then
    return
  fi

  aws ecs update-service \
    --cluster "$cluster" \
    --service "$service" \
    --force-new-deployment \
    --region "$region" >/dev/null

  echo "Triggered ECS redeploy: region=${region}, cluster=${cluster}, service=${service}"
}

SIGNALING_CLUSTER="$(jq -r '.ecs_services.value.signaling.cluster' <<<"$TF_OUTPUT_JSON")"
SIGNALING_SERVICE="$(jq -r '.ecs_services.value.signaling.service' <<<"$TF_OUTPUT_JSON")"
SIGNALING_REGION="$(jq -r '.ecs_services.value.signaling.region' <<<"$TF_OUTPUT_JSON")"

MEDIA_OR_CLUSTER="$(jq -r '.ecs_services.value.media.north_california.cluster' <<<"$TF_OUTPUT_JSON")"
MEDIA_OR_INGRESS="$(jq -r '.ecs_services.value.media.north_california.ingress' <<<"$TF_OUTPUT_JSON")"
MEDIA_OR_EGRESS="$(jq -r '.ecs_services.value.media.north_california.egress' <<<"$TF_OUTPUT_JSON")"
MEDIA_OR_REGION="$(jq -r '.ecs_services.value.media.north_california.region' <<<"$TF_OUTPUT_JSON")"

MEDIA_VA_CLUSTER="$(jq -r '.ecs_services.value.media.north_virginia.cluster' <<<"$TF_OUTPUT_JSON")"
MEDIA_VA_INGRESS="$(jq -r '.ecs_services.value.media.north_virginia.ingress' <<<"$TF_OUTPUT_JSON")"
MEDIA_VA_EGRESS="$(jq -r '.ecs_services.value.media.north_virginia.egress' <<<"$TF_OUTPUT_JSON")"
MEDIA_VA_REGION="$(jq -r '.ecs_services.value.media.north_virginia.region' <<<"$TF_OUTPUT_JSON")"

force_deploy_service "$SIGNALING_CLUSTER" "$SIGNALING_SERVICE" "$SIGNALING_REGION"
force_deploy_service "$MEDIA_OR_CLUSTER" "$MEDIA_OR_INGRESS" "$MEDIA_OR_REGION"
force_deploy_service "$MEDIA_OR_CLUSTER" "$MEDIA_OR_EGRESS" "$MEDIA_OR_REGION"
force_deploy_service "$MEDIA_VA_CLUSTER" "$MEDIA_VA_INGRESS" "$MEDIA_VA_REGION"
force_deploy_service "$MEDIA_VA_CLUSTER" "$MEDIA_VA_EGRESS" "$MEDIA_VA_REGION"

echo "Completed successfully!"
