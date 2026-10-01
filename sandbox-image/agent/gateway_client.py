"""Gateway client — makes API calls through the bot's gateway proxy.

Usage:
    from gateway_client import api_call, fetch

    # Authenticated service call (Google, Shopify, Meta, Slack)
    emails = api_call("google", "GET", "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5")

    # Public HTTP request
    data = fetch("https://api.example.com/data")
    html = fetch("https://example.com", method="GET")
"""

import os
import requests as _requests

GATEWAY_URL = os.environ.get("GATEWAY_URL", "")
SANDBOX_TOKEN = os.environ.get("SANDBOX_TOKEN", "")
USER_ID = os.environ.get("USER_ID", "")

_HEADERS = {
    "X-Sandbox-Token": SANDBOX_TOKEN,
    "X-User-Id": USER_ID,
    "Content-Type": "application/json",
}


def api_call(service, method, url, body=None, headers=None):
    """Authenticated API call through the bot gateway.

    Args:
        service: "google", "shopify", "meta", "whatsapp", "slack"
        method: HTTP method (GET, POST, PUT, PATCH, DELETE)
        url: Full API URL
        body: Optional JSON body (dict)
        headers: Optional extra headers (dict)

    Returns:
        dict with API response data
    """
    if not GATEWAY_URL:
        return {"error": "GATEWAY_URL not configured — gateway not available"}

    payload = {"service": service, "method": method, "url": url}
    if body is not None:
        payload["body"] = body
    if headers is not None:
        payload["headers"] = headers

    resp = _requests.post(
        f"{GATEWAY_URL}/gateway/api",
        json=payload,
        headers=_HEADERS,
        timeout=30,
    )
    return resp.json()


def fetch(url, method="GET", headers=None, body=None):
    """Public HTTP request through the gateway proxy.

    Args:
        url: Full URL to fetch
        method: HTTP method (default GET)
        headers: Optional headers (dict)
        body: Optional JSON body (dict)

    Returns:
        dict with response data
    """
    if not GATEWAY_URL:
        return {"error": "GATEWAY_URL not configured — gateway not available"}

    payload = {"url": url, "method": method}
    if headers is not None:
        payload["headers"] = headers
    if body is not None:
        payload["body"] = body

    resp = _requests.post(
        f"{GATEWAY_URL}/gateway/fetch",
        json=payload,
        headers=_HEADERS,
        timeout=30,
    )
    return resp.json()
