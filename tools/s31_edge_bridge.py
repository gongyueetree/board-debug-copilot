#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import ipaddress
import json
from dataclasses import dataclass
from typing import Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen

from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import uvicorn

app = FastAPI(title="LabSight ESP32-S31 Edge Bridge", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def private_network_headers(request, call_next):
    response = await call_next(request)
    response.headers["Access-Control-Allow-Private-Network"] = "true"
    response.headers["Cache-Control"] = "no-store"
    return response


class ConfigureRequest(BaseModel):
    device_ip: str
    token: str = ""
    scheme: str = "http"


class CaptureRequest(BaseModel):
    resolution: str = "3840x2160"
    quality: int = Field(default=92, ge=50, le=100)
    purpose: str = "evidence"


@dataclass
class Config:
    base_url: str = ""
    token: str = ""


config = Config()


def _safe_host(value: str) -> str:
    raw = value.strip()
    if not raw:
        raise HTTPException(status_code=400, detail="device_ip is required")

    candidate = raw if "://" in raw else f"http://{raw}"
    parsed = urlparse(candidate)
    host = parsed.hostname or ""
    if not host:
        raise HTTPException(status_code=400, detail="invalid device_ip")

    allowed = False
    try:
        ip = ipaddress.ip_address(host)
        allowed = ip.is_private or ip.is_loopback or ip.is_link_local
    except ValueError:
        allowed = host.lower().endswith(".local")

    if not allowed:
        raise HTTPException(
            status_code=400,
            detail="S31 Edge Bridge only allows RFC1918/link-local/localhost or .local devices",
        )

    port = f":{parsed.port}" if parsed.port else ""
    return f"{host}{port}"


def _configure(req: ConfigureRequest) -> None:
    if req.scheme not in {"http", "https"}:
        raise HTTPException(status_code=400, detail="scheme must be http or https")
    host = _safe_host(req.device_ip)
    config.base_url = f"{req.scheme}://{host}"
    config.token = req.token.strip()


def _headers(json_body: bool = False) -> dict[str, str]:
    headers = {"Accept": "application/json, image/jpeg, image/*;q=0.9"}
    if json_body:
        headers["Content-Type"] = "application/json"
    if config.token:
        headers["Authorization"] = f"Bearer {config.token}"
    return headers


def _request(path_or_url: str, method: str = "GET", body: Optional[dict] = None, timeout: float = 12.0):
    if not config.base_url:
        raise HTTPException(status_code=409, detail="S31 bridge is not configured")

    target = path_or_url if path_or_url.startswith(("http://", "https://")) else urljoin(config.base_url + "/", path_or_url.lstrip("/"))
    parsed = urlparse(target)
    base_host = urlparse(config.base_url).hostname
    if parsed.hostname != base_host:
        raise HTTPException(status_code=502, detail="S31 returned an image URL outside the configured device host")

    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = Request(target, data=data, method=method, headers=_headers(body is not None))
    try:
        with urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers.items()), r.read()
    except HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:500]
        raise HTTPException(status_code=502, detail=f"S31 HTTP {e.code}: {detail or e.reason}") from e
    except URLError as e:
        raise HTTPException(status_code=502, detail=f"cannot reach S31: {e.reason}") from e


def _json_response(payload: bytes) -> dict:
    try:
        value = json.loads(payload.decode("utf-8"))
    except Exception as e:
        raise HTTPException(status_code=502, detail="S31 returned invalid JSON") from e
    if not isinstance(value, dict):
        raise HTTPException(status_code=502, detail="S31 JSON response must be an object")
    return value


def _capture(payload: CaptureRequest) -> tuple[bytes, str]:
    status, headers, body = _request(
        "/api/v1/camera/capture",
        method="POST",
        body={
            "resolution": payload.resolution,
            "quality": payload.quality,
            "purpose": payload.purpose,
        },
        timeout=20.0,
    )
    content_type = headers.get("Content-Type", headers.get("content-type", ""))
    if content_type.startswith("image/"):
        return body, content_type.split(";")[0]

    meta = _json_response(body)
    b64 = meta.get("imageBase64") or meta.get("image_base64")
    if isinstance(b64, str) and b64:
        try:
            return base64.b64decode(b64), "image/jpeg"
        except Exception as e:
            raise HTTPException(status_code=502, detail="invalid imageBase64 from S31") from e

    image_url = meta.get("imageUrl") or meta.get("image_url") or meta.get("url")
    if isinstance(image_url, str) and image_url:
        _, image_headers, image = _request(image_url, timeout=20.0)
        image_type = image_headers.get("Content-Type", image_headers.get("content-type", "image/jpeg"))
        return image, image_type.split(";")[0]

    raise HTTPException(
        status_code=502,
        detail="S31 capture must return image/jpeg or JSON containing imageUrl/imageBase64",
    )


@app.get("/health")
def health():
    result = {
        "ok": True,
        "bridge": "labsight-s31-edge",
        "configured": bool(config.base_url),
        "device": config.base_url or None,
    }
    if config.base_url:
        try:
            _, _, body = _request("/api/v1/camera/status", timeout=2.0)
            result["camera"] = _json_response(body)
        except HTTPException as e:
            result["upstream_error"] = e.detail
    return result


@app.post("/configure")
def configure(req: ConfigureRequest):
    _configure(req)
    return {"ok": True, "device": config.base_url}


@app.get("/device")
def device():
    _, _, body = _request("/api/v1/device", timeout=4.0)
    return _json_response(body)


@app.post("/capture")
def capture(req: CaptureRequest):
    image, media_type = _capture(req)
    return Response(
        content=image,
        media_type=media_type or "image/jpeg",
        headers={
            "Cache-Control": "no-store, max-age=0",
            "X-LabSight-Source": "esp32-s31",
            "X-LabSight-Resolution": req.resolution,
        },
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="LabSight local bridge for ESP32-S31 Edge Camera")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18766)
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
