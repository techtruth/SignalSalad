import json
import os

import boto3


def _targets():
    raw = os.environ.get("TARGETS_JSON", "[]")
    return json.loads(raw)


def _target_tier(target):
    if "tier" in target:
        return str(target["tier"]).lower()
    service_name = str(target.get("service", "")).lower()
    return "signaling" if "signaling" in service_name else "media"


def _scale_targets(desired_count: int, allowed_tiers=None):
    tiers = {tier.lower() for tier in (allowed_tiers or [])}
    for target in _targets():
        if tiers and _target_tier(target) not in tiers:
            continue
        region = target["region"]
        cluster = target["cluster"]
        service = target["service"]
        ecs = boto3.client("ecs", region_name=region)
        ecs.update_service(cluster=cluster, service=service, desiredCount=desired_count)


def handler(event, context):
    _scale_targets(1, allowed_tiers=["signaling"])
    return {
        "statusCode": 202,
        "headers": {"content-type": "application/json"},
        "body": json.dumps(
            {
                "status": "starting",
                "phase": "signaling",
                "message": "Signaling startup requested",
            }
        ),
    }
