#!/usr/bin/env python3
"""Minimal Cloudflare API client for GitHub Actions.

Same api() interface as ~/workspace/skills/cloudflare/bin/cf_api.py,
but authenticates with a Bearer token from CLOUDFLARE_API_TOKEN
(GitHub Secret) instead of Muse's credential store.
"""
import json
import os
import urllib.request

API = "https://api.cloudflare.com/client/v4"


def api(method, path, data=None, headers=None):
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    if not token:
        raise RuntimeError("CLOUDFLARE_API_TOKEN is not set")
    url = API + path
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", f"Bearer {token}")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)
