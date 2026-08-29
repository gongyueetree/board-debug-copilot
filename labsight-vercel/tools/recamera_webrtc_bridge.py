#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import json
import logging
from urllib.parse import quote

from aiohttp import web
from aiortc import RTCPeerConnection, RTCSessionDescription
from aiortc.contrib.media import MediaPlayer

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("labsight-recamera-webrtc")

pcs: set[RTCPeerConnection] = set()
players: dict[RTCPeerConnection, MediaPlayer] = {}


def cors(resp: web.StreamResponse) -> web.StreamResponse:
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    resp.headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS"
    resp.headers["Access-Control-Allow-Private-Network"] = "true"
    resp.headers["Cache-Control"] = "no-store"
    return resp


@web.middleware
async def cors_middleware(request: web.Request, handler):
    if request.method == "OPTIONS":
        return cors(web.Response(status=204))
    try:
        response = await handler(request)
    except web.HTTPException as exc:
        response = exc
    return cors(response)


def make_rtsp(camera_ip: str, username: str, password: str, path: str = "/main") -> str:
    user = quote(username or "", safe="")
    pwd = quote(password or "", safe="")
    auth = f"{user}:{pwd}@" if (username or password) else ""
    if not path.startswith("/"):
        path = "/" + path
    return f"rtsp://{auth}{camera_ip}:554{path}"


async def health(request: web.Request):
    return web.json_response({
        "ok": True,
        "bridge": "labsight-recamera-webrtc",
        "peers": len(pcs),
        "version": "0.2.0",
    })


async def offer(request: web.Request):
    body = await request.json()
    sdp = body.get("sdp")
    typ = body.get("type")
    camera_ip = str(body.get("camera_ip") or "").strip()
    username = str(body.get("username") or "admin")
    password = str(body.get("password") or "")
    rtsp_path = str(body.get("rtsp_path") or "/main")
    if not sdp or not typ:
        raise web.HTTPBadRequest(text=json.dumps({"error": "missing sdp/type"}), content_type="application/json")
    if not camera_ip:
        raise web.HTTPBadRequest(text=json.dumps({"error": "missing camera_ip"}), content_type="application/json")

    pc = RTCPeerConnection()
    pcs.add(pc)

    @pc.on("connectionstatechange")
    async def on_state_change():
        log.info("peer state=%s", pc.connectionState)
        if pc.connectionState in {"failed", "closed", "disconnected"}:
            await close_peer(pc)

    await pc.setRemoteDescription(RTCSessionDescription(sdp=sdp, type=typ))

    rtsp_url = make_rtsp(camera_ip, username, password, rtsp_path)
    safe_url = make_rtsp(camera_ip, username, "***", rtsp_path)
    log.info("opening %s", safe_url)

    try:
        player = MediaPlayer(
            rtsp_url,
            format="rtsp",
            options={
                "rtsp_transport": "tcp",
                "stimeout": "5000000",
                "rw_timeout": "5000000",
                "fflags": "nobuffer",
                "flags": "low_delay",
            },
        )
        players[pc] = player
        if player.video is None:
            raise RuntimeError("RTSP stream has no video track")
        pc.addTrack(player.video)
    except Exception as exc:
        await close_peer(pc)
        raise web.HTTPBadGateway(
            text=json.dumps({"error": f"RTSP open failed: {exc}"}),
            content_type="application/json",
        )

    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    return web.json_response({"sdp": pc.localDescription.sdp, "type": pc.localDescription.type})


async def close_peer(pc: RTCPeerConnection):
    players.pop(pc, None)
    if pc in pcs:
        pcs.discard(pc)
    try:
        await pc.close()
    except Exception:
        pass


async def shutdown(app: web.Application):
    await asyncio.gather(*(close_peer(pc) for pc in list(pcs)), return_exceptions=True)


def main():
    parser = argparse.ArgumentParser(description="LabSight reCamera RTSP→WebRTC local bridge")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18765)
    args = parser.parse_args()

    app = web.Application(middlewares=[cors_middleware])
    app.router.add_route("OPTIONS", "/{tail:.*}", lambda request: web.Response(status=204))
    app.router.add_get("/health", health)
    app.router.add_post("/offer", offer)
    app.on_shutdown.append(shutdown)
    log.info("LabSight reCamera WebRTC bridge on http://%s:%s", args.host, args.port)
    web.run_app(app, host=args.host, port=args.port, access_log=None)


if __name__ == "__main__":
    main()
