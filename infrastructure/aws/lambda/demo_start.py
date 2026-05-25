import base64
import json
import os
import uuid
from datetime import datetime, timezone

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


def _read_bool(value, default=False):
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
    return default


def _normalize_bot_count(raw):
    default_count = int(os.environ.get("DEMO_BOT_COUNT_DEFAULT", "20"))
    max_count = int(os.environ.get("DEMO_BOT_COUNT_MAX", "50"))
    try:
        parsed = int(raw)
    except (TypeError, ValueError):
        parsed = default_count
    parsed = max(1, parsed)
    return min(parsed, max_count)


def _normalize_bot_region(raw):
    if isinstance(raw, str):
        candidate = raw.strip().lower()
        if candidate in BOT_REGION_OPTIONS:
            return candidate
    return DEFAULT_BOT_REGION


def _decode_event_body(event):
    payload = event or {}
    body = payload.get("body")
    if body is None:
        return {}

    if payload.get("isBase64Encoded"):
        try:
            body = base64.b64decode(body).decode("utf-8")
        except Exception:
            return {}

    if isinstance(body, dict):
        return body

    if isinstance(body, str):
        stripped = body.strip()
        if not stripped:
            return {}
        try:
            decoded = json.loads(stripped)
        except json.JSONDecodeError:
            return {}
        return decoded if isinstance(decoded, dict) else {}

    return {}


def _launch_state_table():
    table_name = os.environ.get("LAUNCH_STATE_TABLE_NAME", "").strip()
    if not table_name:
        return None
    dynamodb = boto3.resource("dynamodb")
    return dynamodb.Table(table_name)


def _launch_state_key():
    return os.environ.get("LAUNCH_STATE_KEY", "demo-launch")


def _put_launch_state(item):
    table = _launch_state_table()
    if not table:
        return
    table.put_item(Item=item)


def _payment_state_key(order_id: str):
    return f"payment#{order_id}"


def _load_payment_state(order_id: str):
    table = _launch_state_table()
    if not table or not order_id:
        return None
    response = table.get_item(Key={"sessionKey": _payment_state_key(order_id)})
    item = response.get("Item")
    return item if isinstance(item, dict) else None


def _consume_verified_payment(order_id: str, launch_id: str):
    table = _launch_state_table()
    if not table or not order_id:
        return None, "payment table unavailable"

    now = datetime.now(timezone.utc).isoformat()
    try:
        response = table.update_item(
            Key={"sessionKey": _payment_state_key(order_id)},
            UpdateExpression=(
                "SET paymentConsumedAt = :now, paymentConsumedLaunchId = :launchId, updatedAt = :now"
            ),
            ConditionExpression=(
                "paymentStatus = :completed AND attribute_not_exists(paymentConsumedAt)"
            ),
            ExpressionAttributeValues={
                ":now": now,
                ":launchId": launch_id,
                ":completed": "COMPLETED",
            },
            ReturnValues="ALL_NEW",
        )
        attributes = response.get("Attributes")
        if isinstance(attributes, dict):
            return attributes, None
        return None, "payment record missing attributes after consume"
    except ClientError as error:
        code = str(error.response.get("Error", {}).get("Code", ""))
        if code == "ConditionalCheckFailedException":
            existing = _load_payment_state(order_id)
            if not existing:
                return None, "payment record not found"
            if str(existing.get("paymentStatus", "")).upper() != "COMPLETED":
                return None, "payment is not completed"
            if existing.get("paymentConsumedAt"):
                return None, "payment order already used"
            return None, "payment cannot be consumed"
        return None, f"payment consume failed: {error}"


def _response(status_code, payload):
    return {
        "statusCode": status_code,
        "headers": {"content-type": "application/json"},
        "body": json.dumps(payload),
    }


def handler(event, context):
    body = _decode_event_body(event)

    launch_id = str(uuid.uuid4())
    launch_bots = _read_bool(body.get("launchBots"), default=False)
    bot_count = _normalize_bot_count(body.get("botCount")) if launch_bots else 0
    bot_region = _normalize_bot_region(body.get("botRegion"))

    payment = body.get("payment") if isinstance(body.get("payment"), dict) else {}
    payment_mode = payment.get("mode") if isinstance(payment.get("mode"), str) else ""
    payment_satisfied = _read_bool(payment.get("satisfied"), default=False)
    payment_token = payment.get("token") if isinstance(payment.get("token"), str) else None
    payment_order_id = payment.get("orderId") if isinstance(payment.get("orderId"), str) else None
    verified_payment = None

    app_url = body.get("appUrl") if isinstance(body.get("appUrl"), str) else ""
    room = body.get("room") if isinstance(body.get("room"), str) else "demo"
    if not room:
        room = "demo"

    if launch_bots:
        order_id = (payment_order_id or payment_token or "").strip()
        if not order_id:
            return _response(
                400,
                {
                    "status": "failed",
                    "phase": "failed",
                    "message": "Bots launch requires a verified PayPal order",
                },
            )
        verified_payment, consume_error = _consume_verified_payment(order_id, launch_id)
        if consume_error:
            return _response(
                400,
                {
                    "status": "failed",
                    "phase": "failed",
                    "message": f"Bots launch payment validation failed: {consume_error}",
                },
            )

        paid_bot_count = _normalize_bot_count(verified_payment.get("paidBotCount"))
        if paid_bot_count < 1:
            return _response(
                400,
                {
                    "status": "failed",
                    "phase": "failed",
                    "message": "Verified payment did not include any bots",
                },
            )

        bot_count = paid_bot_count
        payment_satisfied = True
        payment_token = order_id
        payment_mode = "paypal"

    _scale_targets(1, allowed_tiers=["signaling"])

    now = datetime.now(timezone.utc).isoformat()
    launch_state = {
        "sessionKey": _launch_state_key(),
        "launchId": launch_id,
        "status": "starting",
        "phase": "signaling",
        "launchBots": launch_bots,
        "botCount": bot_count,
        "botLaunchRequested": False,
        "botInvoked": 0,
        "botOnline": 0,
        "botFailed": 0,
        "botReady": not launch_bots,
        "botRegion": bot_region,
        "mediaScaleRequested": False,
        "appUrl": app_url,
        "room": room,
        "paymentMode": payment_mode or ("paypal" if launch_bots else "none"),
        "paymentSatisfied": payment_satisfied,
        "paymentToken": payment_token or "",
        "paymentOrderId": payment_token or "",
        "paymentVerifiedAmount": (
            str(verified_payment.get("capturedAmount", ""))
            if isinstance(verified_payment, dict)
            else ""
        ),
        "createdAt": now,
        "updatedAt": now,
    }
    _put_launch_state(launch_state)

    return _response(
        202,
        {
            "status": "starting",
            "phase": "signaling",
            "message": "Signaling startup requested",
            "launch": {
                "launchId": launch_id,
                "launchBots": launch_bots,
                "botCount": bot_count,
                "botRegion": bot_region,
                "room": room,
            },
        },
    )
