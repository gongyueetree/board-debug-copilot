#!/usr/bin/env python3
"""Local RTSP → WebRTC video bridge for reCamera and Tapo cameras."""
from __future__ import annotations

import argparse
import asyncio
import ipaddress
import json
import logging
from urllib.parse import quote

from aiohttp import web
from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription
from aiortc.contrib.media import MediaBlackhole, MediaPlayer

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("labsight-recamera-webrtc")
pcs: set[RTCPeerConnection] = set()
players: dict[RTCPeerConnection, MediaPlayer] = {}
audio_sinks: dict[RTCPeerConnection, MediaBlackhole] = {}
EXPIRY_TASKS = web.AppKey("expiry_tasks", set)


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
    # A literal IP only: do not let userinfo, URL delimiters or DNS names change
    # the destination when credentials are added to the URL.
    address = ipaddress.ip_address(camera_ip.strip())
    host = f"[{address}]" if address.version == 6 else str(address)
    if not path.startswith("/"):
        path = "/" + path
    if len(path) > 256 or any(c in path for c in "?#\\\r\n\t "):
        raise ValueError("invalid RTSP path")
    user = quote(username or "", safe="")
    pwd = quote(password or "", safe="")
    auth = f"{user}:{pwd}@" if (username or password) else ""
    return f"rtsp://{auth}{host}:554{path}"


def error_response(status: int, message: str):
    return web.json_response({"error": message}, status=status)


async def health(request: web.Request):
    return web.json_response({
        "ok": True, "bridge": "labsight-recamera-webrtc", "peers": len(pcs),
        "version": "0.3.0", "cameras": ["recamera", "tapo-rtsp"],
    })


def open_player(url: str):
    return MediaPlayer(url, format="rtsp", timeout=8, options={
        "rtsp_transport": "tcp", "rw_timeout": "8000000",
        "fflags": "nobuffer", "flags": "low_delay",
    })


async def expire_unconnected(pc):
    await asyncio.sleep(30)
    if pc in pcs and pc.connectionState != "connected":
        await close_peer(pc)


async def offer(request: web.Request):
    try:
        body = await request.json()
        if not isinstance(body, dict) or body.get("type") != "offer" or not isinstance(body.get("sdp"), str):
            raise ValueError()
        url = make_rtsp(str(body.get("camera_ip") or ""),
                        str(body.get("username") or ""), str(body.get("password") or ""),
                        str(body.get("rtsp_path") or "/main"))
    except (ValueError, TypeError):
        return error_response(400, "Invalid offer, camera IP or RTSP path")
    if len(pcs) >= 4:
        return error_response(429, "Too many camera sessions; disconnect a previous session")

    pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))
    pcs.add(pc)

    @pc.on("connectionstatechange")
    async def on_state_change():
        if pc.connectionState in {"failed", "closed", "disconnected"}:
            await close_peer(pc)

    try:
        await pc.setRemoteDescription(RTCSessionDescription(sdp=body["sdp"], type="offer"))
    except Exception:
        await close_peer(pc)
        return error_response(400, "Invalid WebRTC offer")

    try:
        # RTSP open is blocking. Keep health checks and other peers responsive.
        player = await asyncio.to_thread(open_player, url)
        players[pc] = player
        if pc not in pcs:
            await close_peer(pc)
            return error_response(409, "Camera session was closed")
        if player.video is None:
            raise RuntimeError("no video track")
        # Camera audio is deliberately not forwarded; LabSight uses the local mic.
        pc.addTrack(player.video)
        if player.audio is not None:
            # Drain unused camera audio to prevent an unbounded decoder queue.
            # Stopping it before video starts would close MediaPlayer's container.
            sink = MediaBlackhole()
            sink.addTrack(player.audio)
            audio_sinks[pc] = sink
            await sink.start()
        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        task = asyncio.create_task(expire_unconnected(pc))
        request.app[EXPIRY_TASKS].add(task)
        task.add_done_callback(request.app[EXPIRY_TASKS].discard)
        return web.json_response({"sdp": pc.localDescription.sdp, "type": pc.localDescription.type})
    except Exception as exc:
        # Decoder exceptions may contain the full RTSP URL, including password.
        log.warning("Camera connection failed (%s)", type(exc).__name__)
        await close_peer(pc)
        return error_response(502, "RTSP unavailable. Check camera IP, camera account, privacy mode and stream path; Tapo uses /stream1 or /stream2.")


async def close_peer(pc: RTCPeerConnection):
    sink = audio_sinks.pop(pc, None)
    if sink:
        await sink.stop()
    player = players.pop(pc, None)
    if player:
        for track in (player.video, player.audio):
            if track:
                track.stop()
    pcs.discard(pc)
    if pc.connectionState != "closed":
        await pc.close()


async def shutdown(app: web.Application):
    tasks = list(app[EXPIRY_TASKS])
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    await asyncio.gather(*(close_peer(pc) for pc in list(pcs)), return_exceptions=True)


def create_app():
    app = web.Application(middlewares=[cors_middleware], client_max_size=256 * 1024)
    app[EXPIRY_TASKS] = set()
    app.router.add_get("/health", health)
    app.router.add_post("/offer", offer)
    app.on_shutdown.append(shutdown)
    return app


def main():
    parser = argparse.ArgumentParser(description="LabSight reCamera / Tapo RTSP→WebRTC local bridge")
    parser.add_argument("--host", choices=["127.0.0.1", "::1"], default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18765)
    args = parser.parse_args()
    log.info("LabSight camera bridge on http://%s:%s", args.host, args.port)
    web.run_app(create_app(), host=args.host, port=args.port, access_log=None)


if __name__ == "__main__":
    main()
