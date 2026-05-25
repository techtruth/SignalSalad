import base64
import json
import os
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import boto3

BOT_REGION_OPTIONS = {"north_virginia", "north_california"}
DEFAULT_BOT_REGION = "north_virginia"


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


def _normalize_bot_region(raw):
    if isinstance(raw, str):
        candidate = raw.strip().lower()
        if candidate in BOT_REGION_OPTIONS:
            return candidate
    return DEFAULT_BOT_REGION


def _launch_state_table():
    table_name = os.environ.get("LAUNCH_STATE_TABLE_NAME", "").strip()
    if not table_name:
        return None
    dynamodb = boto3.resource("dynamodb")
    return dynamodb.Table(table_name)


def _payment_state_key(order_id: str):
    return f"payment#{order_id}"


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


def _money(value):
    quantized = Decimal(value).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return f"{quantized:.2f}"


def _build_modal_return_url(app_url: str, bot_region: str, canceled: bool):
    try:
        parsed = urlparse(app_url.strip())
        query = dict(parse_qsl(parsed.query, keep_blank_values=True))
        query["demoModal"] = "1"
        query["region"] = bot_region
        if canceled:
            query["paypalCanceled"] = "1"
            query.pop("paypalReturn", None)
        else:
            query["paypalReturn"] = "1"
            query.pop("paypalCanceled", None)
        return urlunparse(parsed._replace(query=urlencode(query)))
    except Exception:
        suffix = "paypalCanceled=1" if canceled else "paypalReturn=1"
        separator = "&" if "?" in app_url else "?"
        return f"{app_url}{separator}demoModal=1&region={bot_region}&{suffix}"


def handler(event, context):
    try:
        body = _decode_event_body(event)
        bot_count = _normalize_bot_count(body.get("botCount"))
        bot_region = _normalize_bot_region(body.get("botRegion"))
        app_url = body.get("appUrl") if isinstance(body.get("appUrl"), str) else ""

        unit_price = Decimal(os.environ.get("PAYPAL_BOT_UNIT_PRICE_USD", "1.00"))
        total_price = _money(unit_price * Decimal(bot_count))
        unit_price_value = _money(unit_price)

        token = _paypal_access_token()
        create_payload = {
            "intent": "CAPTURE",
            "purchase_units": [
                {
                    "description": "SignalSalad demo bot launch",
                    "custom_id": f"botCount:{bot_count}",
                    "amount": {
                        "currency_code": "USD",
                        "value": total_price,
                        "breakdown": {
                            "item_total": {
                                "currency_code": "USD",
                                "value": total_price,
                            }
                        },
                    },
                    "items": [
                        {
                            "name": "SignalSalad Demo Bot",
                            "quantity": str(bot_count),
                            "unit_amount": {
                                "currency_code": "USD",
                                "value": unit_price_value,
                            },
                            "category": "DIGITAL_GOODS",
                        }
                    ],
                }
            ],
        }

        if app_url:
            return_url = app_url.strip()
            create_payload["application_context"] = {
                "return_url": _build_modal_return_url(return_url, bot_region, canceled=False),
                "cancel_url": _build_modal_return_url(return_url, bot_region, canceled=True),
                "user_action": "PAY_NOW",
            }

        status_code, create_response = _paypal_api_request(
            "POST", "/v2/checkout/orders", token, create_payload
        )
        if status_code not in {200, 201}:
            return _response(
                502,
                {
                    "status": "failed",
                    "message": "PayPal order creation failed",
                    "paypal": create_response,
                },
            )

        order_id = create_response.get("id")
        links = create_response.get("links") if isinstance(create_response.get("links"), list) else []
        approval_url = ""
        for link in links:
            if isinstance(link, dict) and str(link.get("rel", "")).lower() == "approve":
                approval_url = str(link.get("href", ""))
                break

        if not order_id or not approval_url:
            return _response(
                502,
                {
                    "status": "failed",
                    "message": "PayPal order response missing id or approval URL",
                },
            )

        now = _now_iso()
        _put_payment_state(
            {
                "sessionKey": _payment_state_key(order_id),
                "paymentMode": "paypal",
                "paymentStatus": "CREATED",
                "requestedBotCount": bot_count,
                "paidBotCount": 0,
                "botRegion": bot_region,
                "capturedAmount": "0.00",
                "createdAt": now,
                "updatedAt": now,
            }
        )

        return _response(
            200,
            {
                "status": "ok",
                "orderId": order_id,
                "approvalUrl": approval_url,
                "botCount": bot_count,
                "botRegion": bot_region,
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
                "message": f"Payment create failed: {error}",
            },
        )
