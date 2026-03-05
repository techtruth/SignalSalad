import json
import os

import boto3


def _targets():
    raw = os.environ.get("TARGETS_JSON", "[]")
    return json.loads(raw)


def handler(event, context):
    desired_count = int((event or {}).get("desiredCount", 0))

    for target in _targets():
        region = target["region"]
        cluster = target["cluster"]
        service = target["service"]
        ecs = boto3.client("ecs", region_name=region)
        ecs.update_service(cluster=cluster, service=service, desiredCount=desired_count)

    return {
        "statusCode": 200,
        "body": json.dumps({"status": "scaled", "desiredCount": desired_count}),
    }
