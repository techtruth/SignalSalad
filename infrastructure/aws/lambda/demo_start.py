import json
import os

import boto3


def _targets():
    raw = os.environ.get("TARGETS_JSON", "[]")
    return json.loads(raw)


def _scale_targets(desired_count: int):
    for target in _targets():
        region = target["region"]
        cluster = target["cluster"]
        service = target["service"]
        ecs = boto3.client("ecs", region_name=region)
        ecs.update_service(cluster=cluster, service=service, desiredCount=desired_count)


def handler(event, context):
    _scale_targets(1)
    return {
        "statusCode": 202,
        "headers": {"content-type": "application/json"},
        "body": json.dumps(
            {
                "status": "starting",
                "message": "Demo server startup requested",
            }
        ),
    }
