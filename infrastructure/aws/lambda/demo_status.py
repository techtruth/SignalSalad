import json
import os
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import boto3
from botocore.exceptions import ClientError

BOT_REGION_OPTIONS = {"north_virginia", "north_california"}
DEFAULT_BOT_REGION = "north_virginia"


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


def _normalize_bot_region(raw):
    if isinstance(raw, str):
        candidate = raw.strip().lower()
        if candidate in BOT_REGION_OPTIONS:
            return candidate
    return DEFAULT_BOT_REGION


def _with_region_query(app_url, bot_region):
    if not isinstance(app_url, str):
        return ""
    value = app_url.strip()
    if not value:
        return ""

    try:
        parsed = urlparse(value)
        query = dict(parse_qsl(parsed.query, keep_blank_values=True))
        query["region"] = bot_region
        return urlunparse(parsed._replace(query=urlencode(query)))
    except Exception:
        separator = "&" if "?" in value else "?"
        return f"{value}{separator}region={bot_region}"


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


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _launch_state_table():
    table_name = os.environ.get("LAUNCH_STATE_TABLE_NAME", "").strip()
    if not table_name:
        return None
    dynamodb = boto3.resource("dynamodb")
    return dynamodb.Table(table_name)


def _launch_state_key():
    return os.environ.get("LAUNCH_STATE_KEY", "demo-launch")


def _load_launch_state():
    table = _launch_state_table()
    if not table:
        return None
    response = table.get_item(Key={"sessionKey": _launch_state_key()})
    item = response.get("Item")
    return item if isinstance(item, dict) else None


def _persist_launch_state(state):
    table = _launch_state_table()
    if not table or not isinstance(state, dict):
        return
    table.put_item(Item=state)


def _clear_launch_state():
    table = _launch_state_table()
    if not table:
        return
    table.delete_item(Key={"sessionKey": _launch_state_key()})


def _build_launch_payload(state):
    if not isinstance(state, dict):
        return {
            "launchBots": False,
            "botCount": 0,
            "botRegion": DEFAULT_BOT_REGION,
        }
    return {
        "launchId": state.get("launchId"),
        "launchBots": bool(state.get("launchBots")),
        "botCount": int(state.get("botCount", 0)),
        "botRegion": _normalize_bot_region(state.get("botRegion")),
        "room": state.get("room") or "demo",
    }


def _build_bots_payload(state):
    if not isinstance(state, dict) or not state.get("launchBots"):
        return {
            "enabled": False,
            "requested": 0,
            "invoked": 0,
            "online": 0,
            "failed": 0,
            "ready": True,
        }

    requested = int(state.get("botCount", 0))
    invoked = int(state.get("botInvoked", 0))
    online = int(state.get("botOnline", 0))
    failed = int(state.get("botFailed", max(0, requested - invoked)))
    ready = bool(state.get("botReady", False))

    return {
        "enabled": True,
        "requested": requested,
        "invoked": invoked,
        "online": online,
        "failed": failed,
        "ready": ready,
        "launchId": state.get("launchId"),
    }


def _invoke_bot_workers(state):
    requested = int(state.get("botCount", 0))
    worker_arn = os.environ.get("BOT_WORKER_FUNCTION_ARN", "").strip()
    if not worker_arn:
        return {
            "ready": False,
            "requested": requested,
            "invoked": 0,
            "online": 0,
            "failed": requested,
            "message": "BOT_WORKER_FUNCTION_ARN is not configured",
        }

    launch_id = state.get("launchId")
    bot_region = _normalize_bot_region(state.get("botRegion"))
    room = state.get("room") or "demo"
    app_url = _with_region_query(state.get("appUrl") or "", bot_region)

    lambda_client = boto3.client("lambda")
    invoked = 0
    invoke_error = None

    for index in range(1, requested + 1):
        bot_payload = {
            "launchId": launch_id,
            "botIndex": index,
            "botCount": requested,
            "botRegion": bot_region,
            "room": room,
            "appUrl": app_url,
        }
        try:
            invoke_response = lambda_client.invoke(
                FunctionName=worker_arn,
                InvocationType="Event",
                Payload=json.dumps(bot_payload).encode("utf-8"),
            )
            if int(invoke_response.get("StatusCode", 0)) in {200, 202}:
                invoked += 1
        except Exception as error:
            # Deterministic behavior: failed invokes are counted immediately.
            invoke_error = invoke_error or error
            continue

    failed = max(0, requested - invoked)
    ready = invoked == requested
    online = invoked
    message = (
        "All bot worker invokes were accepted"
        if ready
        else "One or more bot worker invokes were not accepted"
    )
    if invoke_error is not None:
        message = f"{message}: {invoke_error}"

    return {
        "ready": ready,
        "requested": requested,
        "invoked": invoked,
        "online": online,
        "failed": failed,
        "message": message,
    }


def _response(status_code, payload):
    return {
        "statusCode": status_code,
        "headers": {"content-type": "application/json"},
        "body": json.dumps(payload),
    }


def _starting_response(phase_name, message, services, state):
    return _response(
        200,
        {
            "status": "starting",
            "phase": phase_name,
            "message": message,
            "services": services,
            "launch": _build_launch_payload(state),
            "bots": _build_bots_payload(state),
        },
    )


def handler(event, context):
    all_stable, services, _ = _describe_targets()
    phase = _phase_status(services)
    all_scaled_down = len(services) > 0 and all(int(svc.get("desiredCount", 0)) == 0 for svc in services)

    launch_state = _load_launch_state()

    if all_scaled_down:
        _clear_launch_state()
        return _response(
            200,
            {
                "status": "idle",
                "phase": "idle",
                "message": "Demo services are not running",
                "services": services,
                "launch": _build_launch_payload(launch_state),
                "bots": _build_bots_payload(launch_state),
            },
        )

    if phase["signaling_ready"] and not phase["media_desired_any"]:
        if not (launch_state and bool(launch_state.get("mediaScaleRequested"))):
            _scale_media_targets_up()
            if launch_state:
                launch_state["mediaScaleRequested"] = True
                launch_state["phase"] = "media-starting"
                launch_state["status"] = "starting"
                launch_state["updatedAt"] = _now_iso()
                _persist_launch_state(launch_state)

        return _starting_response(
            "media-starting",
            "Signaling is stable. Media startup requested.",
            services,
            launch_state,
        )

    if all_stable:
        if launch_state and bool(launch_state.get("launchBots")):
            if not bool(launch_state.get("botLaunchRequested")):
                launch_state["botLaunchRequested"] = True
                launch_state["updatedAt"] = _now_iso()

                launch_result = _invoke_bot_workers(launch_state)
                launch_state["botInvoked"] = int(launch_result.get("invoked", 0))
                launch_state["botOnline"] = int(launch_result.get("online", 0))
                launch_state["botFailed"] = int(launch_result.get("failed", 0))
                launch_state["botReady"] = bool(launch_result.get("ready", False))
                launch_state["botLaunchMessage"] = launch_result.get("message", "")

                if launch_state["botReady"]:
                    launch_state["phase"] = "bots-online"
                    launch_state["status"] = "starting"
                else:
                    launch_state["phase"] = "failed"
                    launch_state["status"] = "failed"

                _persist_launch_state(launch_state)

            if not bool(launch_state.get("botReady")):
                launch_state["status"] = "failed"
                launch_state["phase"] = "failed"
                launch_state["updatedAt"] = _now_iso()
                _persist_launch_state(launch_state)
                return _response(
                    200,
                    {
                        "status": "failed",
                        "phase": "failed",
                        "message": launch_state.get("botLaunchMessage")
                        or "Bot launch did not meet requested count",
                        "services": services,
                        "launch": _build_launch_payload(launch_state),
                        "bots": _build_bots_payload(launch_state),
                    },
                )

            schedule_info = _schedule_stop()
            launch_state["status"] = "ready"
            launch_state["phase"] = "ready"
            launch_state["updatedAt"] = _now_iso()
            _persist_launch_state(launch_state)
            return _response(
                200,
                {
                    "status": "ready",
                    "phase": "ready",
                    "message": "Demo servers and bots are stable and ready",
                    "services": services,
                    "launch": _build_launch_payload(launch_state),
                    "bots": _build_bots_payload(launch_state),
                    **schedule_info,
                },
            )

        schedule_info = _schedule_stop()
        if launch_state:
            launch_state["status"] = "ready"
            launch_state["phase"] = "ready"
            launch_state["updatedAt"] = _now_iso()
            _persist_launch_state(launch_state)
        return _response(
            200,
            {
                "status": "ready",
                "phase": "ready",
                "message": "Demo servers are stable and ready",
                "services": services,
                "launch": _build_launch_payload(launch_state),
                "bots": _build_bots_payload(launch_state),
                **schedule_info,
            },
        )

    if not phase["signaling_ready"]:
        message = "Waiting for signaling service to become stable"
        phase_name = "signaling"
    elif not phase["media_ready"]:
        message = "Waiting for media services to become stable"
        phase_name = "media"
    else:
        message = "Demo servers are still starting"
        phase_name = "starting"

    if launch_state:
        launch_state["status"] = "starting"
        launch_state["phase"] = phase_name
        launch_state["updatedAt"] = _now_iso()
        _persist_launch_state(launch_state)

    return _starting_response(phase_name, message, services, launch_state)
