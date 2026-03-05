import json
import os
from datetime import datetime, timedelta, timezone

import boto3
from botocore.exceptions import ClientError


def _targets():
    raw = os.environ.get("TARGETS_JSON", "[]")
    return json.loads(raw)


def _group_targets():
    grouped = {}
    for target in _targets():
        key = (target["region"], target["cluster"])
        grouped.setdefault(key, []).append(target["service"])
    return grouped


def _service_is_stable(service):
    desired = int(service.get("desiredCount", 0))
    running = int(service.get("runningCount", 0))
    pending = int(service.get("pendingCount", 0))
    deployments = service.get("deployments", [])

    if desired < 1:
        return False
    if running < desired or pending > 0:
        return False
    if deployments and any(dep.get("rolloutState") != "COMPLETED" for dep in deployments):
        return False
    return True


def _describe_targets():
    service_states = []

    for (region, cluster), services in _group_targets().items():
        ecs = boto3.client("ecs", region_name=region)

        for i in range(0, len(services), 10):
            batch = services[i : i + 10]
            response = ecs.describe_services(cluster=cluster, services=batch)
            for service in response.get("services", []):
                service_states.append(
                    {
                        "region": region,
                        "cluster": cluster,
                        "service": service.get("serviceName"),
                        "desiredCount": service.get("desiredCount", 0),
                        "runningCount": service.get("runningCount", 0),
                        "pendingCount": service.get("pendingCount", 0),
                        "stable": _service_is_stable(service),
                    }
                )

    all_stable = len(service_states) > 0 and all(s["stable"] for s in service_states)
    return all_stable, service_states


def _schedule_stop():
    minutes = int(os.environ.get("DEMO_SERVER_WARM_MINUTES", "15"))
    stop_fn_arn = os.environ["STOP_FUNCTION_ARN"]
    scheduler_role_arn = os.environ["SCHEDULER_ROLE_ARN"]
    schedule_name = os.environ.get("DEMO_STOP_SCHEDULE_NAME", "signalsalad-demo-stop")
    schedule_group_name = os.environ.get("DEMO_STOP_SCHEDULE_GROUP", "default")

    now_utc = datetime.now(timezone.utc)
    run_at = now_utc + timedelta(minutes=minutes)
    at_expression = run_at.strftime("at(%Y-%m-%dT%H:%M:%S)")

    target = {
        "Arn": stop_fn_arn,
        "RoleArn": scheduler_role_arn,
        "Input": json.dumps({"desiredCount": 0}),
    }

    schedule_args = {
        "ScheduleExpression": at_expression,
        "ScheduleExpressionTimezone": "UTC",
        "FlexibleTimeWindow": {"Mode": "OFF"},
        "ActionAfterCompletion": "DELETE",
        "Target": target,
    }

    scheduler = boto3.client("scheduler")
    was_updated = False
    try:
        scheduler.create_schedule(
            Name=schedule_name,
            GroupName=schedule_group_name,
            **schedule_args,
        )
    except ClientError as error:
        error_code = error.response.get("Error", {}).get("Code")
        if error_code != "ConflictException":
            raise
        scheduler.update_schedule(
            Name=schedule_name,
            GroupName=schedule_group_name,
            **schedule_args,
        )
        was_updated = True

    return {
        "scheduleName": schedule_name,
        "scheduleGroupName": schedule_group_name,
        "scheduleUpdated": was_updated,
        "stopAtUtc": run_at.isoformat(),
        "warmMinutes": minutes,
    }


def handler(event, context):
    all_stable, services = _describe_targets()

    if all_stable:
        schedule_info = _schedule_stop()
        return {
            "statusCode": 200,
            "headers": {"content-type": "application/json"},
            "body": json.dumps(
                {
                    "status": "ready",
                    "message": "Demo servers are stable and ready",
                    "services": services,
                    **schedule_info,
                }
            ),
        }

    return {
        "statusCode": 200,
        "headers": {"content-type": "application/json"},
        "body": json.dumps(
            {
                "status": "starting",
                "message": "Demo servers are still starting",
                "services": services,
            }
        ),
    }
