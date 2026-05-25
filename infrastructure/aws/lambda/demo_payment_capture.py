import base64
import json
import os
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import boto3


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


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


def _response(status_code, payload):
    return {
        "statusCode": status_code,
        "headers": {"content-type": "application/json"},
        "body": json.dumps(payload),
    }


def _normalize_bot_count(raw):
    default_count = int(os.environ.get("DEMO_BOT_COUNT_DEFAULT", "20"))
    max_count = int(os.environ.get("DEMO_BOT_COUNT_MAX", "50"))
    try:
        parsed = int(raw)
    except (TypeError, ValueError):
        parsed = default_count
    parsed = max(1, parsed)
    return min(parsed, max_count)


def _launch_state_table():
    table_name = os.environ.get("LAUNCH_STATE_TABLE_NAME", "").strip()
    if not table_name:
        return None
    dynamodb = boto3.resource("dynamodb")
    return dynamodb.Table(table_name)


def _payment_state_key(order_id: str):
    return f"payment#{order_id}"


def _get_payment_state(order_id: str):
    table = _launch_state_table()
    if not table:
        return None
    response = table.get_item(Key={"sessionKey": _payment_state_key(order_id)})
    item = response.get("Item")
    return item if isinstance(item, dict) else None


def _put_payment_state(item):
    table = _launch_state_table()
    if not table:
        return
    table.put_item(Item=item)


def _paypal_base_url():
    env = os.environ.get("PAYPAL_ENV", "live").strip().lower()
    return "https://api-m.sandbox.paypal.com" if env == "sandbox" else "https://api-m.paypal.com"


def _paypal_credentials():
    client_id = os.environ.get("PAYPAL_CLIENT_ID", "").strip()
    client_secret = os.environ.get("PAYPAL_CLIENT_SECRET", "").strip()
    if not client_id or not client_secret:
        raise RuntimeError("PayPal credentials are not configured")
    return client_id, client_secret


def _paypal_access_token():
    client_id, client_secret = _paypal_credentials()
    basic = base64.b64encode(f"{client_id}:{client_secret}".encode("utf-8")).decode("ascii")
    request = Request(
        f"{_paypal_base_url()}/v1/oauth2/token",
        data=b"grant_type=client_credentials",
        method="POST",
        headers={
            "Authorization": f"Basic {basic}",
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        },
    )
    with urlopen(request, timeout=15) as response:
        payload = json.loads(response.read().decode("utf-8"))
        token = payload.get("access_token")
        if not isinstance(token, str) or not token:
            raise RuntimeError("PayPal token response missing access_token")
        return token


def _paypal_api_request(method, path, token, payload=None):
    body = None
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
    request = Request(f"{_paypal_base_url()}{path}", data=body, method=method, headers=headers)

    try:
        with urlopen(request, timeout=20) as response:
            text = response.read().decode("utf-8")
            return response.status, json.loads(text) if text else {}
    except HTTPError as error:
        text = error.read().decode("utf-8") if hasattr(error, "read") else ""
        payload = {}
        if text:
            try:
                payload = json.loads(text)
            except Exception:
                payload = {"message": text}
        return error.code, payload


def _extract_paid_bot_count(order_payload, fallback_count):
    purchase_units = order_payload.get("purchase_units")
    if not isinstance(purchase_units, list) or not purchase_units:
        return _normalize_bot_count(fallback_count)

    first_unit = purchase_units[0] if isinstance(purchase_units[0], dict) else {}
    items = first_unit.get("items") if isinstance(first_unit.get("items"), list) else []
    if items and isinstance(items[0], dict):
        quantity = items[0].get("quantity")
        return _normalize_bot_count(quantity)

    custom_id = first_unit.get("custom_id") if isinstance(first_unit.get("custom_id"), str) else ""
    if custom_id.startswith("botCount:"):
        return _normalize_bot_count(custom_id.split(":", 1)[1])

    return _normalize_bot_count(fallback_count)


def _extract_captured_amount(order_payload):
    purchase_units = order_payload.get("purchase_units")
    if not isinstance(purchase_units, list) or not purchase_units:
        return "0.00"

    first_unit = purchase_units[0] if isinstance(purchase_units[0], dict) else {}
    payments = first_unit.get("payments") if isinstance(first_unit.get("payments"), dict) else {}
    captures = payments.get("captures") if isinstance(payments.get("captures"), list) else []
    if captures and isinstance(captures[0], dict):
        amount = captures[0].get("amount") if isinstance(captures[0].get("amount"), dict) else {}
        value = amount.get("value")
        if isinstance(value, str) and value:
            return value

    amount = first_unit.get("amount") if isinstance(first_unit.get("amount"), dict) else {}
    value = amount.get("value")
    return value if isinstance(value, str) and value else "0.00"


def handler(event, context):
    try:
        body = _decode_event_body(event)
        order_id = body.get("orderId") if isinstance(body.get("orderId"), str) else ""
        order_id = order_id.strip()
        if not order_id:
            return _response(400, {"status": "failed", "message": "orderId is required"})

        payment_state = _get_payment_state(order_id) or {}
        if payment_state.get("paymentConsumedAt"):
            return _response(
                200,
                {
                    "status": "ok",
                    "payment": {
                        "mode": "paypal",
                        "orderId": order_id,
                        "completed": False,
                        "paymentStatus": "CONSUMED",
                        "paidBotCount": 0,
                        "capturedAmount": str(payment_state.get("capturedAmount", "0.00")),
                    },
                },
            )

        fallback_count = payment_state.get("requestedBotCount", 1)

        token = _paypal_access_token()
        status_code, capture_payload = _paypal_api_request(
            "POST", f"/v2/checkout/orders/{order_id}/capture", token, {}
        )

        if status_code in {200, 201}:
            details_status, details_payload = _paypal_api_request(
                "GET", f"/v2/checkout/orders/{order_id}", token
            )
            order_payload = details_payload if details_status in {200, 201} else capture_payload
        else:
            # Order may already be captured; fetch current details and continue deterministically.
            details_status, details_payload = _paypal_api_request(
                "GET", f"/v2/checkout/orders/{order_id}", token
            )
            if details_status not in {200, 201}:
                return _response(
                    400,
                    {
                        "status": "failed",
                        "message": "PayPal capture failed",
                        "paypal": capture_payload,
                    },
                )
            order_payload = details_payload

        order_status = str(order_payload.get("status", "")).upper()
        paid_bot_count = _extract_paid_bot_count(order_payload, fallback_count)
        captured_amount = _extract_captured_amount(order_payload)
        completed = order_status == "COMPLETED"

        now = _now_iso()
        _put_payment_state(
            {
                "sessionKey": _payment_state_key(order_id),
                "paymentMode": "paypal",
                "paymentStatus": "COMPLETED" if completed else order_status,
                "requestedBotCount": _normalize_bot_count(fallback_count),
                "paidBotCount": paid_bot_count if completed else 0,
                "capturedAmount": captured_amount,
                "paypalOrderId": order_id,
                "createdAt": payment_state.get("createdAt", now),
                "updatedAt": now,
            }
        )

        return _response(
            200,
            {
                "status": "ok",
                "payment": {
                    "mode": "paypal",
                    "orderId": order_id,
                    "completed": completed,
                    "paymentStatus": "COMPLETED" if completed else order_status,
                    "paidBotCount": paid_bot_count if completed else 0,
                    "capturedAmount": captured_amount,
                },
            },
        )
    except URLError as error:
        return _response(
            502,
            {
                "status": "failed",
                "message": f"PayPal network error: {error}",
            },
        )
    except Exception as error:
        return _response(
            500,
            {
                "status": "failed",
                "message": f"Payment capture failed: {error}",
            },
        )
