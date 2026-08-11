"""M2K Bridge - local-only ADALM2000 gateway.

Security boundary (CLAUDE.md rule 5): binds 127.0.0.1 only, validates Origin,
and requires a paired token for anything that can drive hardware. The cloud
never touches USB; the browser talks to this process directly, which is why an
https frontend can still reach ws://127.0.0.1 (localhost exemption).

This module is routing and authorisation only. Waveform generation lives in
adapters/, the wire format in protocol.py, pairing in pairing.py.
"""

from __future__ import annotations

import asyncio
import os
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

try:
    from .adapters import AdapterError, AwgConfig, ScopeConfig, create_adapter
    from .adapters.base import AWG_MAX_FREQ, AWG_MAX_OFFSET, AWG_MAX_VPP, SCOPE_MAX_RATE
    from .adapters.mock_m2k import MockM2kAdapter
    from .pairing import PairingManager
    from .protocol import error_frame, measurements_frame, waveform_frame
except ImportError:  # pragma: no cover - packaged (PyInstaller) run
    from adapters import AdapterError, AwgConfig, ScopeConfig, create_adapter
    from adapters.base import AWG_MAX_FREQ, AWG_MAX_OFFSET, AWG_MAX_VPP, SCOPE_MAX_RATE
    from adapters.mock_m2k import MockM2kAdapter
    from pairing import PairingManager
    from protocol import error_frame, measurements_frame, waveform_frame

ALLOWED_ORIGINS = [
    o.strip()
    for o in os.getenv(
        "BRIDGE_ALLOWED_ORIGINS",
        "http://localhost:3000,https://board-debug-copilot.vercel.app",
    ).split(",")
    if o.strip()
]

#: Pairing can be disabled for automated tests and the built-in demo, but never
#: silently: /status reports it so the UI can warn.
PAIRING_REQUIRED = os.getenv("BRIDGE_REQUIRE_PAIRING", "true").lower() == "true"

#: Scenario switching changes the waveform, the measurements and therefore the
#: AI diagnosis. It is mock-only, but that is not a reason to leave it open -
#: anything that changes what the operator sees is a control surface. CI and
#: the built-in demo opt out explicitly rather than by default.
ALLOW_UNPAIRED_DEBUG = os.getenv("BRIDGE_ALLOW_UNPAIRED_DEBUG", "false").lower() == "true"

Scenario = Literal["normal", "gain_error", "clipping", "noisy", "no_response"]

app = FastAPI(title="M2K Bridge", version="0.3.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

adapter = create_adapter()
pairing = PairingManager()


# ---------------------------------------------------------------- auth


def _check_token(authorization: str | None) -> None:
    token = authorization[7:] if authorization and authorization.startswith("Bearer ") else None
    if not pairing.is_valid(token):
        raise HTTPException(
            status_code=401,
            detail={
                "code": "NOT_PAIRED",
                "message": "未配对或 token 已失效。请在 Bridge 控制台查看配对码并重新配对",
            },
        )


def require_token(authorization: str | None = Header(default=None)) -> None:
    """Guard for anything that can drive hardware.

    MOCK_MODE does not bypass this: a demo that skips the security step is not
    demonstrating the product.
    """
    if not PAIRING_REQUIRED:
        return
    _check_token(authorization)


def require_debug_token(authorization: str | None = Header(default=None)) -> None:
    """Guard for the mock scenario switch.

    Same rule as hardware control, with one explicit escape hatch for CI and
    the built-in demo. BRIDGE_MOCK alone is not an escape hatch.
    """
    if not PAIRING_REQUIRED or ALLOW_UNPAIRED_DEBUG:
        return
    _check_token(authorization)


def _adapter_error(exc: AdapterError) -> HTTPException:
    status = 422 if exc.code == "LIMIT_EXCEEDED" else 503
    return HTTPException(status_code=status, detail={"code": exc.code, "message": str(exc)})


# ---------------------------------------------------------------- models


class AwgRequest(BaseModel):
    channel: Literal["W1", "W2"] = "W1"
    wave: Literal["sine", "square", "triangle", "sawtooth", "dc"] = "sine"
    freqHz: float = Field(default=1000.0, ge=0, le=AWG_MAX_FREQ)
    amplitudeVpp: float = Field(default=0.4, ge=0, le=AWG_MAX_VPP)
    offsetV: float = Field(default=0.0, ge=-AWG_MAX_OFFSET, le=AWG_MAX_OFFSET)
    #: The frontend must have shown the confirm dialog first (CLAUDE.md rule 6).
    #: Enforced here too, because the UI is not the only possible caller.
    confirm: bool = False

    def to_config(self) -> AwgConfig:
        return AwgConfig(
            channel=self.channel,
            wave=self.wave,
            freq_hz=self.freqHz,
            amplitude_vpp=self.amplitudeVpp,
            offset_v=self.offsetV,
        )


class MeasureRequest(BaseModel):
    """一次性采集。samples 给大一点能测更低的频率，但耗时也更长。"""

    samples: int = Field(default=2048, ge=64, le=65536)


class ScopeRequest(BaseModel):
    timebaseSPerDiv: float = 0.0005
    sampleRate: float = Field(default=1_000_000.0, gt=0, le=SCOPE_MAX_RATE)
    running: bool = True

    def to_config(self) -> ScopeConfig:
        return ScopeConfig(
            timebase_s_per_div=self.timebaseSPerDiv,
            sample_rate=self.sampleRate,
            running=self.running,
        )


class ScenarioRequest(BaseModel):
    scenario: Scenario


class PairingVerifyRequest(BaseModel):
    code: str = Field(min_length=6, max_length=6)


class PairingRevokeRequest(BaseModel):
    token: str | None = None


# ---------------------------------------------------------------- status


@app.get("/status")
def status() -> dict:
    """Unauthenticated on purpose: the UI needs to know whether to show the
    pairing prompt before it has a token."""
    s = adapter.status()
    return {
        "connected": s.connected,
        "device": s.device,
        "serial": s.serial,
        "firmware": s.firmware,
        "mock": s.mock,
        "running": s.running,
        "scenario": s.scenario,
        "detail": s.detail,
        "adapter": adapter.name,
        "hardwareVerified": s.hardware_verified,
        "experimental": s.experimental,
        "pairingRequired": PAIRING_REQUIRED,
        "allowUnpairedDebug": ALLOW_UNPAIRED_DEBUG,
        **pairing.status(),
    }


@app.get("/devices")
def devices(_: None = Depends(require_token)) -> dict:
    try:
        return {"devices": adapter.list_devices()}
    except AdapterError as exc:
        raise _adapter_error(exc) from exc


@app.post("/devices/connect")
def connect(uri: str | None = None, _: None = Depends(require_token)) -> dict:
    try:
        s = adapter.connect(uri)
    except AdapterError as exc:
        raise _adapter_error(exc) from exc
    return {"connected": s.connected, "device": s.device, "detail": s.detail}


@app.post("/devices/disconnect")
def disconnect(_: None = Depends(require_token)) -> dict:
    adapter.disconnect()
    return {"connected": False}


# ---------------------------------------------------------------- pairing


@app.get("/pairing/status")
def pairing_status() -> dict:
    return {
        **pairing.status(),
        "pairingRequired": PAIRING_REQUIRED,
        "allowUnpairedDebug": ALLOW_UNPAIRED_DEBUG,
    }


@app.post("/pairing/start")
def pairing_start() -> dict:
    return pairing.start()


@app.post("/pairing/verify")
def pairing_verify(req: PairingVerifyRequest) -> dict:
    try:
        token = pairing.verify(req.code)
    except PermissionError as exc:
        raise HTTPException(
            status_code=403, detail={"code": "PAIRING_FAILED", "message": str(exc)}
        ) from exc
    return {"token": token, "expiresInDays": 30}


@app.post("/pairing/revoke")
def pairing_revoke(req: PairingRevokeRequest) -> dict:
    return {"revoked": pairing.revoke(req.token)}


# ---------------------------------------------------------------- control


@app.post("/awg")
def configure_awg(req: AwgRequest, _: None = Depends(require_token)) -> dict:
    config = req.to_config()
    # Order matters: hardware limits are absolute, so they are checked before
    # confirmation. A confirmed 20Vpp is still impossible.
    try:
        from .adapters.base import check_hardware_limits, requires_confirm
    except ImportError:  # pragma: no cover
        from adapters.base import check_hardware_limits, requires_confirm

    try:
        check_hardware_limits(config)
    except AdapterError as exc:
        raise _adapter_error(exc) from exc

    if requires_confirm(config) and not req.confirm:
        raise HTTPException(
            status_code=428,
            detail={
                "code": "CONFIRM_REQUIRED",
                "message": "幅度 > 5Vpp 或偏置非 0，需要用户二次确认后重发",
                "amplitudeVpp": req.amplitudeVpp,
                "offsetV": req.offsetV,
            },
        )

    try:
        return adapter.configure_awg(config)
    except AdapterError as exc:
        raise _adapter_error(exc) from exc


@app.post("/awg/disable")
def disable_awg(_: None = Depends(require_token)) -> dict:
    adapter.disable_awg()
    return {"enabled": False}


@app.post("/scope")
def configure_scope(req: ScopeRequest, _: None = Depends(require_token)) -> dict:
    try:
        return adapter.configure_scope(req.to_config())
    except AdapterError as exc:
        raise _adapter_error(exc) from exc


@app.post("/scope/measure")
def measure_once(
    req: MeasureRequest | None = None, _: None = Depends(require_token)
) -> dict:
    """采一帧并返回测量值，不返回波形数组。

    这条是给**真机联调**准备的：验证数据通道通不通只需要几个数字，
    而 WebSocket 需要一个 WS 客户端、网页需要整套栈起来 —— curl 就能干的事
    不该逼人装东西。

    不返回原始波形：一帧 2048 点两通道走 JSON 是几十 KB，而回答
    「通了没有」只需要 Vpp、频率、增益。要看波形形状走 /ws。
    """
    body = req or MeasureRequest()
    try:
        frame = adapter.read_scope_frame(0, samples=body.samples)
    except AdapterError as exc:
        raise _adapter_error(exc) from exc

    return {
        "sampleRate": frame.sample_rate,
        "samples": int(len(frame.ch1)),
        # 请求值也报出来。现在两个 adapter 都支持 samples，正常应该相等；
        # 不相等就说明 adapter 没按请求采，那是需要被看见的。
        "requestedSamples": body.samples,
        "measurements": frame.measurements,
    }


@app.get("/diagnostics")
def diagnostics(_: None = Depends(require_token)) -> dict:
    """把「哪一步成了、哪一步没成」摊开。

    真机排查时笼统的失败信息最费时间。真实适配器会记录每个可选 libm2k 调用
    的成败、协商到的采样率、以及最近一次 AWG 的实际输出频率。
    """
    fn = getattr(adapter, "diagnostics", None)
    if fn is None:
        return {"adapter": adapter.name, "detail": "该适配器没有诊断信息（mock 不需要）"}
    return {"adapter": adapter.name, **fn()}


@app.post("/emergency-stop")
def emergency_stop() -> dict:
    """Deliberately unauthenticated: a stop button that can fail closed because
    of an expired token is worse than no stop button."""
    adapter.emergency_stop()
    return {"stopped": True}


@app.get("/scenarios")
def list_scenarios() -> dict:
    if not isinstance(adapter, MockM2kAdapter):
        return {"current": None, "available": []}
    try:
        from .scenarios import SPECS
    except ImportError:  # pragma: no cover
        from scenarios import SPECS
    return {
        "current": adapter.scenario,
        "available": [{"id": k, "label": v.label} for k, v in SPECS.items()],
    }


@app.post("/debug/scenario")
def set_scenario(req: ScenarioRequest, _: None = Depends(require_debug_token)) -> dict:
    if not isinstance(adapter, MockM2kAdapter):
        raise HTTPException(
            status_code=409,
            detail={"code": "NOT_MOCK", "message": "场景切换仅在 BRIDGE_MOCK=true 下可用"},
        )
    adapter.set_scenario(req.scenario)
    return {"scenario": req.scenario}


# ---------------------------------------------------------------- stream


def _origin_allowed(origin: str | None) -> bool:
    # No Origin header means a non-browser client (curl, tests); allow it.
    return origin is None or origin in ALLOWED_ORIGINS


@app.websocket("/ws")
async def ws(sock: WebSocket, token: str | None = Query(default=None)) -> None:
    if not _origin_allowed(sock.headers.get("origin")):
        await sock.close(code=4403)
        return

    # Browsers cannot set headers on a WebSocket handshake, so the token comes
    # as a query parameter. Same check, different carrier.
    header = sock.headers.get("authorization")
    supplied = token or (header[7:] if header and header.startswith("Bearer ") else None)
    if PAIRING_REQUIRED and not pairing.is_valid(supplied):
        await sock.close(code=4401)
        return

    await sock.accept()
    sequence = 0
    try:
        while True:
            try:
                frame = adapter.read_scope_frame(sequence)
            except AdapterError as exc:
                await sock.send_text(error_frame(exc.code, str(exc)))
                await asyncio.sleep(1.0)
                continue

            await sock.send_text(waveform_frame(frame))
            await sock.send_text(measurements_frame(frame))
            sequence += 1
            await asyncio.sleep(0.1)
    except WebSocketDisconnect:
        return
    except Exception:
        await sock.close(code=1011)


def main() -> None:
    import uvicorn

    if PAIRING_REQUIRED and not pairing.status()["paired"]:
        print("\n未配对。网页点「连接本地 Bridge」后，本窗口会显示配对码。\n", flush=True)

    uvicorn.run(app, host="127.0.0.1", port=3777)


if __name__ == "__main__":
    main()
