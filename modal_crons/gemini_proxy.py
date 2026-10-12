"""
Modal Gemini Proxy for Pocket Personal (stream-dual plan).

Endpoints:
  POST /gemini        {model, contents, tools, generationConfig, systemInstruction, api_key} -> JSON
  POST /gemini/stream {model, contents, tools, generationConfig, systemInstruction, api_key} -> SSE stream
  GET  /health -> {"status": "ok"}

Auth: Header "X-Proxy-Token" must match GEMINI_PROXY_TOKEN (Modal secret).
Gemini API key comes in request body (from Worker secrets), proxy only forwards.

Why: Cloudflare Workers egress IPs are blocked by Google. Modal IPs are not.
Worker calls this proxy directly via HTTPS instead of D1 queue + VM poller.

Secrets (Modal dashboard -> Secrets -> "gemini-proxy"):
  - GEMINI_PROXY_TOKEN: bearer token for endpoints
"""
import json
import modal

app = modal.App("gemini-proxy")

proxy_image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("httpx", "fastapi")
)

GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models"


def _build_payload(data: dict):
    payload = {"contents": data.get("contents", [])}
    for k in ("tools", "generationConfig", "systemInstruction"):
        if data.get(k):
            payload[k] = data[k]
    return payload


@app.function(image=proxy_image, secrets=[modal.Secret.from_name("gemini-proxy")], timeout=120)
@modal.asgi_app()
def fastapi_app():
    from fastapi import FastAPI, Header, HTTPException
    from fastapi.responses import JSONResponse, StreamingResponse
    from typing import Optional, Any
    from pydantic import BaseModel

    web_app = FastAPI(title="Gemini Proxy")

    class GeminiRequest(BaseModel):
        model: str = "gemini-3.8-flash"
        contents: Any
        tools: Optional[Any] = None
        generationConfig: Optional[Any] = None
        systemInstruction: Optional[Any] = None
        api_key: str

    @web_app.get("/health")
    async def health_check():
        return {"status": "ok"}

    @web_app.post("/gemini")
    async def proxy_gemini(req: GeminiRequest, x_proxy_token: str = Header(None)):
        import httpx
        import os
        token = os.environ.get("GEMINI_PROXY_TOKEN", "")
        if not token or x_proxy_token != token:
            raise HTTPException(status_code=401, detail="Invalid proxy token")
        if not req.api_key:
            raise HTTPException(status_code=400, detail="API key required")

        url = f"{GEMINI_BASE}/{req.model}:generateContent"
        payload = _build_payload(req.model_dump())

        async with httpx.AsyncClient(timeout=60.0) as client:
            try:
                r = await client.post(
                    url,
                    params={"key": req.api_key},
                    json=payload,
                    headers={"Content-Type": "application/json"},
                )
            except Exception as e:
                raise HTTPException(status_code=502, detail=f"Upstream error: {e}")

        try:
            data = r.json()
        except Exception:
            data = {"raw": r.text[:500]}
        return JSONResponse(status_code=r.status_code, content=data)

    @web_app.post("/gemini/stream")
    async def proxy_gemini_stream(req: GeminiRequest, x_proxy_token: str = Header(None)):
        import httpx
        import os
        token = os.environ.get("GEMINI_PROXY_TOKEN", "")
        if not token or x_proxy_token != token:
            raise HTTPException(status_code=401, detail="Invalid proxy token")
        if not req.api_key:
            raise HTTPException(status_code=400, detail="API key required")

        url = f"{GEMINI_BASE}/{req.model}:streamGenerateContent"
        payload = _build_payload(req.model_dump())

        async def event_generator():
            async with httpx.AsyncClient(timeout=120.0) as client:
                try:
                    async with client.stream(
                        "POST",
                        url,
                        params={"key": req.api_key, "alt": "sse"},
                        json=payload,
                        headers={"Content-Type": "application/json"},
                    ) as r:
                        if r.status_code != 200:
                            err_text = await r.aread()
                            yield f'data: {json.dumps({"error": f"Gemini {r.status_code}: {err_text.decode()[:500]}"})}\n\n'
                            return
                        async for line in r.aiter_lines():
                            if line.startswith("data: "):
                                yield line + "\n\n"
                except Exception as e:
                    yield f'data: {json.dumps({"error": str(e)[:500]})}\n\n'
            yield "data: [DONE]\n\n"

        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
            },
        )

    return web_app
