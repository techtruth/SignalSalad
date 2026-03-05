import json
import os
from datetime import datetime, timedelta, timezone

import boto3
from botocore.exceptions import ClientError


def _targets():
    raw = os.environ.get("TARGETS_JSON", "[]")
    return json.loads(raw)


def _target_tier(target):
    if "tier" in target:
        return str(target["tier"]).lower()
    service_name = str(target.get("service", "")).lower()
    return "signaling" if "signaling" in service_name else "media"


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
    by_name = {}
    target_by_service = {target["service"]: target for target in _targets()}

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
                        "tier": _target_tier(target_by_service.get(service.get("serviceName"), {})),
                        "desiredCount": service.get("desiredCount", 0),
                        "runningCount": service.get("runningCount", 0),
                        "pendingCount": service.get("pendingCount", 0),
                        "stable": _service_is_stable(service),
                    }
                )
                by_name[service.get("serviceName")] = service_states[-1]

    all_stable = len(service_states) > 0 and all(s["stable"] for s in service_states)
    return all_stable, service_states, by_name


def _scale_media_targets_up():
    for target in _targets():
        if _target_tier(target) != "media":
            continue
        ecs = boto3.client("ecs", region_name=target["region"])
        ecs.update_service(
            cluster=target["cluster"],
            service=target["service"],
            desiredCount=1,
        )


def _phase_status(services):
    signaling = [svc for svc in services if svc.get("tier") == "signaling"]
    media = [svc for svc in services if svc.get("tier") == "media"]

    signaling_ready = len(signaling) > 0 and all(svc.get("stable") for svc in signaling)
    media_desired_any = any(int(svc.get("desiredCount", 0)) > 0 for svc in media)
    media_ready = len(media) > 0 and all(svc.get("stable") for svc in media)

    return {
        "signaling_ready": signaling_ready,
        "media_desired_any": media_desired_any,
        "media_ready": media_ready,
    }


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
    all_stable, services, _ = _describe_targets()
    phase = _phase_status(services)

    if phase["signaling_ready"] and not phase["media_desired_any"]:
        _scale_media_targets_up()
        return {
            "statusCode": 200,
            "headers": {"content-type": "application/json"},
            "body": json.dumps(
                {
                    "status": "starting",
                    "phase": "media-starting",
                    "message": "Signaling is stable. Media startup requested.",
                    "services": services,
                }
            ),
        }

    if all_stable:
        schedule_info = _schedule_stop()
        return {
            "statusCode": 200,
            "headers": {"content-type": "application/json"},
            "body": json.dumps(
                {
                    "status": "ready",
                    "phase": "ready",
                    "message": "Demo servers are stable and ready",
                    "services": services,
                    **schedule_info,
                }
            ),
        }

    if not phase["signaling_ready"]:
        message = "Waiting for signaling service to become stable"
        phase_name = "signaling"
    elif not phase["media_ready"]:
        message = "Waiting for media services to become stable"
        phase_name = "media"
    else:
        message = "Demo servers are still starting"
        phase_name = "starting"

    return {
        "statusCode": 200,
        "headers": {"content-type": "application/json"},
        "body": json.dumps(
            {
                "status": "starting",
                "phase": phase_name,
                "message": message,
                "services": services,
            }
        ),
    }
