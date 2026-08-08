"""M2K Bridge - local-only ADALM2000 gateway.

Security boundary (CLAUDE.md rule 5): binds 127.0.0.1 only and validates Origin.
The cloud never touches USB; the browser talks to this process directly, which
is why an https frontend can still reach ws://127.0.0.1 (localhost exemption).

BRIDGE_MOCK=true synthesizes waveforms with numpy so the whole flow runs with
no hardware. Scenario values come from docs/05 section 11.1.
"""

from __future__ import annotations

import asyncio
import json
import os
from typing import Literal

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .scenarios import SCENARIOS, SPECS, measure, synthesize

BRIDGE_MOCK = os.getenv("BRIDGE_MOCK", "true").lower() == "true"
ALLOWED_ORIGINS = [
    o.strip()
    for o in os.getenv(
        "BRIDGE_ALLOWED_ORIGINS",
        "http://localhost:3000,https://board-debug-copilot.vercel.app",
    ).split(",")
    if o.strip()
]

# ADALM2000 hard limits - anything beyond these is rejected outright
AWG_MAX_VPP = 10.0
AWG_MAX_OFFSET = 5.0
AWG_MAX_FREQ = 30_000_000.0
SCOPE_MAX_RATE = 100_000_000.0

Scenario = Literal["normal", "gain_error", "clipping", "noisy", "no_response"]

app = FastAPI(title="M2K Bridge", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

_state: dict[str, object] = {
    "scenario": os.getenv("BRIDGE_SCENARIO", "gain_error"),
    "running": True,
    "sample_rate": 1_000_000.0,
    "awg_enabled": False,
    "awg": None,
}


class Status(BaseModel):
    connected: bool
    device: str | None
    serial: str | None
    firmware: str | None
    mock: bool
    scenario: str
    running: bool


class ScenarioRequest(BaseModel):
    scenario: Scenario


class AwgConfig(BaseModel):
    channel: Literal["W1", "W2"] = "W1"
    wave: Literal["sine", "square", "triangle", "sawtooth", "dc"] = "sine"
    freqHz: float = Field(default=1000.0, ge=0, le=AWG_MAX_FREQ)
    amplitudeVpp: float = Field(default=0.4, ge=0, le=AWG_MAX_VPP)
    offsetV: float = Field(default=0.0, ge=-AWG_MAX_OFFSET, le=AWG_MAX_OFFSET)
    #: The frontend must have shown the confirm dialog before sending a
    #: dangerous value (CLAUDE.md rule 6). The bridge enforces it too, because
    #: the UI is not the only possible caller.
    confirm: bool = False


class ScopeConfig(BaseModel):
    timebaseSPerDiv: float = 0.0005
    sampleRate: float = Field(default=1_000_000.0, gt=0, le=SCOPE_MAX_RATE)
    running: bool = True


def requires_confirm(cfg: AwgConfig) -> bool:
    return cfg.amplitudeVpp > 5.0 or cfg.offsetV != 0.0


@app.get("/status", response_model=Status)
def status() -> Status:
    scenario = str(_state["scenario"])
    if BRIDGE_MOCK:
        return Status(
            connected=True,
            device="ADALM2000",
            serial="104122A8BC2F",
            firmware="0.39",
            mock=True,
            scenario=scenario,
            running=bool(_state["running"]),
        )
    return Status(
        connected=False,
        device=None,
        serial=None,
        firmware=None,
        mock=False,
        scenario=scenario,
        running=False,
    )


@app.get("/devices")
def devices() -> dict[str, object]:
    if BRIDGE_MOCK:
        return {"devices": [{"uri": "mock://m2k", "name": "ADALM2000 (mock)"}]}
    return {"devices": []}


@app.get("/scenarios")
def list_scenarios() -> dict[str, object]:
    return {
        "current": _state["scenario"],
        "available": [{"id": s, "label": SPECS[s].label} for s in SCENARIOS],
    }


@app.post("/debug/scenario")
def set_scenario(req: ScenarioRequest) -> dict[str, str]:
    _state["scenario"] = req.scenario
    return {"scenario": req.scenario}


@app.post("/awg")
def configure_awg(cfg: AwgConfig) -> dict[str, object]:
    if requires_confirm(cfg) and not cfg.confirm:
        raise HTTPException(
            status_code=428,
            detail={
                "code": "CONFIRM_REQUIRED",
                "message": "幅度 > 5Vpp 或偏置非 0，需要用户二次确认后重发",
                "amplitudeVpp": cfg.amplitudeVpp,
                "offsetV": cfg.offsetV,
            },
        )
    _state["awg"] = cfg.model_dump()
    _state["awg_enabled"] = True
    return {"applied": True, "awg": _state["awg"]}


@app.post("/awg/disable")
def disable_awg() -> dict[str, bool]:
    _state["awg_enabled"] = False
    return {"enabled": False}


@app.post("/scope")
def configure_scope(cfg: ScopeConfig) -> dict[str, object]:
    _state["sample_rate"] = cfg.sampleRate
    _state["running"] = cfg.running
    return {"applied": True, "sampleRate": cfg.sampleRate, "running": cfg.running}


@app.post("/emergency-stop")
def emergency_stop() -> dict[str, bool]:
    _state["awg_enabled"] = False
    _state["running"] = False
    return {"stopped": True}


def _origin_allowed(origin: str | None) -> bool:
    # No Origin header means a non-browser client (curl, tests); allow it.
    return origin is None or origin in ALLOWED_ORIGINS


@app.websocket("/ws")
async def ws(sock: WebSocket) -> None:
    if not _origin_allowed(sock.headers.get("origin")):
        await sock.close(code=4403)
        return

    await sock.accept()
    sequence = 0
    try:
        while True:
            if not _state["running"]:
                await asyncio.sleep(0.2)
                continue

            rate = float(_state["sample_rate"])
            ch1, ch2 = synthesize(str(_state["scenario"]), sample_rate=rate, sequence=sequence)

            await sock.send_text(
                json.dumps(
                    {
                        "type": "waveform",
                        # Decimate for transport: the browser only needs display
                        # resolution, and the raw array never leaves this process.
                        "ch1": [round(v, 4) for v in ch1[::4].tolist()],
                        "ch2": [round(v, 4) for v in ch2[::4].tolist()],
                        "meta": {"fs": rate, "ts": sequence * 0.1, "sequence": sequence},
                    }
                )
            )
            await sock.send_text(
                json.dumps({"type": "measurements", **measure(ch1, ch2, rate)})
            )

            sequence += 1
            await asyncio.sleep(0.1)
    except WebSocketDisconnect:
        return
    except Exception:
        await sock.close(code=1011)


def main() -> None:
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=3777)


if __name__ == "__main__":
    main()
