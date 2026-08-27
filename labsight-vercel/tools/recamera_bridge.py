#!/usr/bin/env python3
from __future__ import annotations

import argparse
import threading
import time
from dataclasses import dataclass
from typing import Optional
from urllib.parse import quote

import av
import cv2
import numpy as np
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn

app = FastAPI(title="LabSight reCamera Bridge", version="0.1.0")
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
    camera_ip: str
    username: str = "admin"
    password: str = ""
    rtsp_path: str = "/live"
    rtsp_port: int = 554

@dataclass
class FrameState:
    jpg: Optional[bytes] = None
    width: int = 0
    height: int = 0
    fps: float = 0.0
    connected: bool = False
    error: str = "not configured"
    url_redacted: str = ""
    configured_at: float = 0.0

state = FrameState()
lock = threading.Lock()
worker: Optional[threading.Thread] = None
worker_stop = threading.Event()

def make_rtsp_url(c: ConfigureRequest) -> str:
    user = quote(c.username, safe="")
    password = quote(c.password, safe="")
    auth = f"{user}:{password}@" if (c.username or c.password) else ""
    path = c.rtsp_path if c.rtsp_path.startswith("/") else f"/{c.rtsp_path}"
    return f"rtsp://{auth}{c.camera_ip}:{c.rtsp_port}{path}"

def redacted_url(c: ConfigureRequest) -> str:
    path = c.rtsp_path if c.rtsp_path.startswith("/") else f"/{c.rtsp_path}"
    return f"rtsp://{c.username}:***@{c.camera_ip}:{c.rtsp_port}{path}"

def decode_loop(url: str, redacted: str):
    global state
    reconnect_delay = 0.5
    while not worker_stop.is_set():
        container = None
        try:
            with lock:
                state.connected = False
                state.error = "connecting"
                state.url_redacted = redacted
            container = av.open(
                url,
                options={
                    "rtsp_transport": "tcp",
                    "stimeout": "5000000",
                    "rw_timeout": "5000000",
                    "fflags": "nobuffer",
                    "flags": "low_delay",
                },
                timeout=5.0,
            )
            video_stream = next((s for s in container.streams if s.type == "video"), None)
            if video_stream is None:
                raise RuntimeError("RTSP stream has no video track")
            last = time.perf_counter()
            ema_fps = 0.0
            for frame in container.decode(video=video_stream.index):
                if worker_stop.is_set():
                    break
                img = frame.to_ndarray(format="bgr24")
                ok, enc = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), 88])
                if not ok:
                    continue
                now = time.perf_counter()
                dt = max(1e-6, now - last)
                inst = 1.0 / dt
                ema_fps = inst if ema_fps == 0 else ema_fps * 0.85 + inst * 0.15
                last = now
                with lock:
                    state.jpg = enc.tobytes()
                    state.width = int(img.shape[1])
                    state.height = int(img.shape[0])
                    state.fps = round(ema_fps, 1)
                    state.connected = True
                    state.error = ""
                reconnect_delay = 0.5
        except Exception as e:
            with lock:
                state.connected = False
                state.error = str(e)[:400]
            time.sleep(reconnect_delay)
            reconnect_delay = min(4.0, reconnect_delay * 1.7)
        finally:
            try:
                if container is not None:
                    container.close()
            except Exception:
                pass

def start_worker(cfg: ConfigureRequest):
    global worker
    worker_stop.set()
    if worker and worker.is_alive():
        worker.join(timeout=1.2)
    worker_stop.clear()
    url = make_rtsp_url(cfg)
    redacted = redacted_url(cfg)
    with lock:
        state.jpg = None
        state.width = 0
        state.height = 0
        state.fps = 0.0
        state.connected = False
        state.error = "connecting"
        state.url_redacted = redacted
        state.configured_at = time.time()
    worker = threading.Thread(target=decode_loop, args=(url, redacted), daemon=True)
    worker.start()

@app.get("/health")
def health():
    with lock:
        return {
            "ok": True,
            "bridge": "labsight-recamera",
            "connected": state.connected,
            "width": state.width,
            "height": state.height,
            "fps": state.fps,
            "error": state.error,
            "rtsp": state.url_redacted,
        }

@app.post("/configure")
def configure(req: ConfigureRequest):
    if not req.camera_ip.strip():
        raise HTTPException(status_code=400, detail="camera_ip is required")
    start_worker(req)
    return {"ok": True, "camera_ip": req.camera_ip, "rtsp": redacted_url(req), "width": state.width, "height": state.height}

@app.get("/frame.jpg")
def frame_jpg():
    with lock:
        jpg = state.jpg
        connected = state.connected
        error = state.error
    if not jpg:
        raise HTTPException(status_code=503, detail=error or ("connecting" if not connected else "no frame yet"))
    return Response(content=jpg, media_type="image/jpeg", headers={"Cache-Control": "no-store, max-age=0"})

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="LabSight local RTSP bridge for Seeed reCamera Pro")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
