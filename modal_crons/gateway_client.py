"""modal_crons/gateway_client.py — AI Gateway ($0) + Workers AI cho consensus.

BOI CANH (bao cao workers-ai-gateway-research-20261106, Chot 16:00 06/11):
  - Consensus (dong thuan) duoc sinh boi consensus_runlog.py NGOAI repo nay
    (VM/Modal script — worker chi doc R2 market/consensus*.json, xem
    worker/src/stock.js:2261-2268). Chuoi cu Cerebras → LLM7 → Gemini → Radox
    KHONG nam trong repo; day la client chuan hoa de dau moi nop vao script do.
  - Gateway lo fallback TANG TRANSPORT (4xx/5xx/timeout/network → leg tiep).
  - Fallback TANG VERDICT (no-rating → doi leg) GIU TRONG CODE ham
    consensus_call() duoi day — gateway khong nhin thay phan quyet.
  - Radox/LLM7: AI Gateway khong ho tro custom endpoint → giu goi truc tiep
    nhu cu (ngoai module nay).
  - Key: khong hardcode — doc tu bien moi truong:
      AI_GATEWAY_ENABLED (=1 bat), AI_GATEWAY_ACCOUNT_ID, AI_GATEWAY_ID
      (mac dinh 'default', gateway tu sinh o request dau tien theo docs),
      CEREBRAS_API_KEY, GEMINI_API_KEYS (ngan phay),
      CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN (Workers AI $0).

Chi dung stdlib (urllib) — chay duoc o VM lan Modal, khong them dependency.
"""
import json
import os
import re
import urllib.error
import urllib.request

GW_BASE = "https://gateway.ai.cloudflare.com/v1"
MODEL_CEREBRAS = "cerebras/gpt-oss-120b"
MODEL_WORKERSAI_GATEWAY = "workers-ai/@cf/openai/gpt-oss-120b"
MODEL_WORKERSAI = "@cf/openai/gpt-oss-120b"  # binding/REST $0, 10k Neuron/ngay
DEFAULT_GEMINI_MODEL = "gemini-3.5-flash"

_NO_RATING_RE = re.compile(
    r"no.?\s*-?\s*rating|khong.?\s*co.?\s*(khuyen nghi|dong thuan)", re.I)


def gateway_enabled(env=None):
    env = env if env is not None else os.environ
    return (env.get("AI_GATEWAY_ENABLED", "").strip() == "1"
            and bool(env.get("AI_GATEWAY_ACCOUNT_ID", "").strip()))


def gateway_url(env=None):
    env = env if env is not None else os.environ
    acct = env.get("AI_GATEWAY_ACCOUNT_ID", "").strip()
    gw = env.get("AI_GATEWAY_ID", "default").strip() or "default"
    return "%s/%s/%s/compat/chat/completions" % (GW_BASE, acct, gw)


def gemini_keys(env=None):
    env = env if env is not None else os.environ
    return [k.strip() for k in env.get("GEMINI_API_KEYS", "").split(",") if k.strip()]


def gateway_legs(env=None):
    """Leg thu tu: cerebras → google-ai-studio/gemini → workers-ai.
    Chi leg co key moi duoc them (khong hardcode key)."""
    env = env if env is not None else os.environ
    legs = []
    ck = env.get("CEREBRAS_API_KEY", "").strip()
    if ck:
        legs.append((MODEL_CEREBRAS, [ck]))
    gk = gemini_keys(env)
    if gk:
        gmodel = env.get("AI_CHAT_MODEL", DEFAULT_GEMINI_MODEL).strip()
        legs.append(("google-ai-studio/" + gmodel, gk))
    tok = env.get("CLOUDFLARE_API_TOKEN", "").strip()
    if tok:
        legs.append((MODEL_WORKERSAI_GATEWAY, [tok]))
    return legs


def _post_json(url, headers, payload, timeout):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"), method="POST")
    for k, v in headers.items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(body)
        except ValueError:
            return e.code, {"error": body[:300]}
    except Exception as e:  # network/timeout → tinh nhu loi transport
        raise GatewayError("transport:%s" % type(e).__name__)


class GatewayError(RuntimeError):
    pass


class QuotaError(RuntimeError):
    """Workers AI het 10.000 Neuron/ngay (free): loi co kiem soat."""
    pass


def gateway_chat(messages, env=None, timeout=30, max_tokens=1024, only_model=None):
    """Goi compat endpoint. only_model = danh vao 1 leg (cho verdict fallback
    o tang app); khong co = thu lan cac leg (fallback tang transport:
    4xx/5xx/timeout/network → key/leg tiep theo). Tra (text, model_leg).
    Het leg → GatewayError."""
    legs = gateway_legs(env)
    if only_model:
        legs = [(m, ks) for m, ks in legs if m == only_model]
    if not legs:
        raise GatewayError("gateway_no_legs")
    url = gateway_url(env)
    last = None
    for model, keys in legs:
        for key in keys:
            payload = {"model": model, "messages": messages,
                       "temperature": 0.2, "max_tokens": max_tokens}
            status, body = _post_json(
                url, {"Content-Type": "application/json",
                      "Authorization": "Bearer " + key}, payload, timeout)
            if status == 200:
                try:
                    text = body["choices"][0]["message"]["content"] or ""
                except (KeyError, IndexError, TypeError):
                    last = "bad_shape"
                    continue
                return text, model
            last = "http_%s" % status
            continue  # 401/403/429/5xx → key tiep, het key thi leg tiep
    raise GatewayError("gateway_down:%s" % last)


def workers_ai_chat(messages, env=None, timeout=60, max_tokens=1024):
    """Chan $0 du phong: Workers AI REST (binding binding=AI chi co trong
    Worker JS, ngoai script dung REST). Het quota → QuotaError (co kiem soat,
    khong crash, khong try them)."""
    env = env if env is not None else os.environ
    acct = env.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
    tok = env.get("CLOUDFLARE_API_TOKEN", "").strip()
    if not acct or not tok:
        raise GatewayError("workersai_unconfigured")
    url = ("https://api.cloudflare.com/client/v4/accounts/%s/ai/run/%s"
           % (acct, MODEL_WORKERSAI))
    payload = {"messages": messages, "temperature": 0.2, "max_tokens": max_tokens}
    status, body = _post_json(
        url, {"Content-Type": "application/json", "Authorization": "Bearer " + tok},
        payload, timeout)
    if status != 200:
        msg = ""
        try:
            msg = str((body.get("errors") or [{}])[0].get("message", ""))
        except AttributeError:
            pass
        if status in (402, 429) or re.search(r"quota|neuron|exceed|allocation",
                                             msg + str(body), re.I):
            raise QuotaError("workers_ai_quota:http_%s" % status)
        raise GatewayError("workersai_http_%s" % status)
    return body.get("response") or ""


def parse_verdict(text):
    """Verdict consensus = JSON dau cuoi co truong `rating`. Khong doc
    duoc JSON → rating None (tinh = no-rating, doi leg)."""
    t = text or ""
    i, k = t.find("{"), t.rfind("}")
    if i < 0 or k <= i:
        return {"rating": None, "raw": t[:200]}
    try:
        j = json.loads(t[i:k + 1])
        return j if isinstance(j, dict) else {"rating": None, "raw": t[:200]}
    except ValueError:
        return {"rating": None, "raw": t[:200]}


def is_no_rating(verdict):
    if not isinstance(verdict, dict):
        return True
    r = verdict.get("rating")
    if r is None or not str(r).strip():
        return True
    return bool(_NO_RATING_RE.search(str(r)))


def consensus_call(messages, env=None, timeout=30, max_tokens=1024):
    """Mot luot goi nao consensus: transport fallback qua gateway
    (cerebras → gemini → workers-ai), ket hop chan $0 Workers AI truc tiep,
    VA verdict fallback (no-rating → doi leg) giu trong code.

    Tra dict: {ok, via, verdict, trace} hoac {ok: False, reason, trace}."""
    env = env if env is not None else os.environ
    trace = []
    quota_hit = False
    last_no_rating = None

    # 1) Cac leg gateway (cerebras, gemini; workers-ai leg co token thi van
    #    nam trong danh sach — thu duoc ca hai duong la an toan).
    if gateway_enabled(env):
        for model, _keys in gateway_legs(env):
            try:
                # only_model: dinh 1 leg de verdict fallback (no-rating → doi
                # leg) nam duoc o trong code; transport fallback cac key cua
                # leg do van chay ben trong gateway_chat.
                text, via = gateway_chat(messages, env=env, timeout=timeout,
                                         max_tokens=max_tokens, only_model=model)
            except GatewayError as e:
                trace.append("gw:%s" % e)
                continue
            verdict = parse_verdict(text)
            trace.append("gw:%s:ok" % via)
            if not is_no_rating(verdict):
                return {"ok": True, "via": via, "verdict": verdict, "trace": trace}
            last_no_rating = {"via": via, "verdict": verdict}
            trace.append("gw:%s:no-rating" % via)
    else:
        # Gateway tat: giu duong goi truc tiep nhu cu cho gemini (1 leg).
        gk = gemini_keys(env)
        if gk:
            try:
                text = _direct_gemini(messages, gk[0], env, timeout, max_tokens)
            except GatewayError as e:
                trace.append("direct:%s" % e)
                text = None
            if text is not None:
                verdict = parse_verdict(text)
                trace.append("direct-gemini:ok")
                if not is_no_rating(verdict):
                    return {"ok": True, "via": "direct-gemini",
                            "verdict": verdict, "trace": trace}
                last_no_rating = {"via": "direct-gemini", "verdict": verdict}

    # 2) Chan $0 du phong: Workers AI truc tiep.
    try:
        text = workers_ai_chat(messages, env=env, max_tokens=max_tokens)
        verdict = parse_verdict(text)
        trace.append("workersai-0$:ok")
        if not is_no_rating(verdict):
            return {"ok": True, "via": "workersai-0$", "verdict": verdict,
                    "trace": trace}
        last_no_rating = {"via": "workersai-0$", "verdict": verdict}
    except QuotaError as e:
        quota_hit = True
        trace.append(str(e))  # loi co kiem soat — khong dot quota them
    except GatewayError as e:
        trace.append("workersai:%s" % e)

    if last_no_rating:  # moi leg deu no-rating → tra verdict cuoi (app tu xu)
        out = {"ok": True, "no_rating": True, **last_no_rating, "trace": trace}
        if quota_hit:
            out["quota"] = True
        return out
    if quota_hit:
        return {"ok": False, "reason": "workers_ai_quota", "trace": trace}
    return {"ok": False, "reason": "brain_down", "trace": trace}


def _direct_gemini(messages, key, env, timeout, max_tokens):
    """Duong cu: generateContent truc tiep (chi dung khi gateway tat)."""
    env = env if env is not None else os.environ
    model = env.get("AI_CHAT_MODEL", DEFAULT_GEMINI_MODEL).strip()
    url = ("https://generativelanguage.googleapis.com/v1beta/models/"
           "%s:generateContent" % model)
    contents = [{"role": "model" if m["role"] == "assistant" else "user",
                 "parts": [{"text": m["content"]}]}
                for m in messages if m["role"] != "system"]
    payload = {"contents": contents,
               "generationConfig": {"temperature": 0.2,
                                    "maxOutputTokens": max_tokens}}
    sys = [m for m in messages if m["role"] == "system"]
    if sys:
        payload["systemInstruction"] = {"parts": [{"text": sys[0]["content"]}]}
    status, body = _post_json(
        url, {"Content-Type": "application/json", "x-goog-api-key": key},
        payload, timeout)
    if status != 200:
        raise GatewayError("gemini_http_%s" % status)
    try:
        parts = body["candidates"][0]["content"]["parts"]
    except (KeyError, IndexError, TypeError):
        raise GatewayError("gemini_bad_shape")
    return " ".join(p.get("text", "") for p in parts if isinstance(p, dict)).strip()
