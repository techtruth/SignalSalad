#!/usr/bin/env bash
set -euo pipefail

# Quick helper for local AWS deploy iteration:
# 1) Build and push signaling/media/bot-worker images to ECR
# 2) Force ECS services to pull latest tags
# 3) Refresh bot-worker Lambda image reference

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(cd "${INFRA_DIR}/../.." && pwd)"
cd "$INFRA_DIR"

DOCKER_CMD="${DOCKER_CMD:-docker}"
TF_OUTPUT_JSON="$(terraform output -json)"

SIGNALING_REPO="$(jq -r '.ecr_repositories.value.signaling' <<<"$TF_OUTPUT_JSON")"
MEDIA_REPO="$(jq -r '.ecr_repositories.value.media' <<<"$TF_OUTPUT_JSON")"
BOT_WORKER_REPO="$(jq -r '.ecr_repositories.value["bot-worker"]' <<<"$TF_OUTPUT_JSON")"
ECR_REGISTRY_DOMAIN="$(jq -r '.ecr_registry_domain.value' <<<"$TF_OUTPUT_JSON")"
AWS_ECR_REGION="${AWS_ECR_REGION:-$(cut -d'.' -f4 <<<"$ECR_REGISTRY_DOMAIN")}" 

SIGNALING_IMAGE="${SIGNALING_REPO}:latest"
MEDIA_IMAGE="${MEDIA_REPO}:latest"
BOT_WORKER_IMAGE="${BOT_WORKER_REPO}:latest"

# Build and push local images.
"$DOCKER_CMD" build -f "${ROOT_DIR}/containerization/Dockerfile.signaling" -t "$SIGNALING_IMAGE" "$ROOT_DIR"
"$DOCKER_CMD" build -f "${ROOT_DIR}/containerization/Dockerfile.media" -t "$MEDIA_IMAGE" "$ROOT_DIR"
"$DOCKER_CMD" build -f "${ROOT_DIR}/containerization/Dockerfile.bot.lambda" -t "$BOT_WORKER_IMAGE" "$ROOT_DIR"

ECR_PASSWORD="$(aws ecr get-login-password --region "${AWS_ECR_REGION}")"
printf '%s' "$ECR_PASSWORD" | "$DOCKER_CMD" login --username AWS --password-stdin "${ECR_REGISTRY_DOMAIN}"

"$DOCKER_CMD" push "$SIGNALING_IMAGE"
"$DOCKER_CMD" push "$MEDIA_IMAGE"
"$DOCKER_CMD" push "$BOT_WORKER_IMAGE"

BOT_WORKER_LAMBDA_ARN="$(jq -r '.demo_bot_worker_lambda_arn.value // empty' <<<"$TF_OUTPUT_JSON")"
if [[ -n "$BOT_WORKER_LAMBDA_ARN" ]]; then
  BOT_WORKER_REGION="$(cut -d':' -f4 <<<"$BOT_WORKER_LAMBDA_ARN")"
  if aws lambda get-function --function-name "$BOT_WORKER_LAMBDA_ARN" --region "$BOT_WORKER_REGION" >/dev/null 2>&1; then
    aws lambda update-function-code \
      --function-name "$BOT_WORKER_LAMBDA_ARN" \
      --image-uri "$BOT_WORKER_IMAGE" \
      --region "$BOT_WORKER_REGION" >/dev/null
    echo "Updated bot worker Lambda image: ${BOT_WORKER_LAMBDA_ARN}"
  else
    echo "Bot worker Lambda not found; skipped Lambda image update (${BOT_WORKER_LAMBDA_ARN})"
  fi
fi

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
