from __future__ import annotations

import base64
import hmac
import os
import random
import struct
import time
import uuid
import zlib
from hashlib import sha256
from typing import Any

import requests
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI(title="LabSight Shengwang Voice Adapter", version="0.10.9")
API_BASE = "https://api.agora.io/cn/api/conversational-ai-agent/v2/projects"


class ShengwangSessionRequest(BaseModel):
    action: str = "start"
    agent_id: str | None = None
    channel: str | None = None
    provider: str | None = None
    text: str | None = None
    tts_target: str | None = None


def _env(*names: str, required: bool = True) -> str:
    for name in names:
        value = os.getenv(name, "").strip()
        if value:
            return value
    if required:
        raise HTTPException(status_code=503, detail=f"未配置 {' / '.join(names)}")
    return ""


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=f"环境变量 {name} 不是有效整数：{raw}") from exc


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=f"环境变量 {name} 不是有效数字：{raw}") from exc


def _app_id() -> str:
    return _env("SHENGWANG_APP_ID", "AGORA_APP_ID")


def _app_cert() -> str:
    return _env("SHENGWANG_APP_CERTIFICATE", "AGORA_APP_CERTIFICATE")


def _auth() -> str:
    customer_id = _env("SHENGWANG_CUSTOMER_ID", "AGORA_CUSTOMER_ID")
    customer_secret = _env("SHENGWANG_CUSTOMER_SECRET", "AGORA_CUSTOMER_SECRET")
    return "Basic " + base64.b64encode(f"{customer_id}:{customer_secret}".encode()).decode()


def _pack_u16(value: int) -> bytes:
    return struct.pack("<H", int(value))


def _pack_u32(value: int) -> bytes:
    return struct.pack("<I", int(value))


def _pack_string(value: bytes) -> bytes:
    return _pack_u16(len(value)) + value


def _pack_privileges(values: dict[int, int]) -> bytes:
    ordered = sorted(values.items())
    return _pack_u16(len(ordered)) + b"".join(_pack_u16(k) + _pack_u32(v) for k, v in ordered)


def _validate_hex32(name: str, value: str) -> None:
    if len(value) != 32:
        raise HTTPException(status_code=500, detail=f"{name} 长度应为 32 个十六进制字符")
    try:
        bytes.fromhex(value)
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=f"{name} 不是有效十六进制字符串") from exc


def _rtc_token(app_id: str, app_cert: str, channel: str, uid: int, ttl: int = 3600) -> str:
    _validate_hex32("SHENGWANG_APP_ID", app_id)
    _validate_hex32("SHENGWANG_APP_CERTIFICATE", app_cert)
    issue_ts = int(time.time())
    salt = random.randint(1, 99_999_999)
    expiry = max(1, int(ttl))
    service = (
        _pack_u16(1)
        + _pack_privileges({1: expiry, 2: expiry, 3: expiry, 4: expiry})
        + _pack_string(channel.encode())
        + _pack_string(b"" if uid == 0 else str(uid).encode())
    )
    signing = hmac.new(_pack_u32(issue_ts), app_cert.encode(), sha256).digest()
    signing = hmac.new(_pack_u32(salt), signing, sha256).digest()
    info = _pack_string(app_id.encode()) + _pack_u32(issue_ts) + _pack_u32(expiry) + _pack_u32(salt) + _pack_u16(1) + service
    signature = hmac.new(signing, info, sha256).digest()
    return "007" + base64.b64encode(zlib.compress(_pack_string(signature) + info)).decode()


def _public_base_url() -> str:
    host = (
        os.getenv("LABSIGHT_PUBLIC_BASE_URL", "").strip()
        or os.getenv("VERCEL_PROJECT_PRODUCTION_URL", "").strip()
        or os.getenv("VERCEL_URL", "").strip()
    )
    if not host:
        return ""
    if not host.startswith(("http://", "https://")):
        host = "https://" + host
    return host.rstrip("/")


def _custom_llm_url() -> str:
    explicit = _env("SHENGWANG_CUSTOM_LLM_URL", "AGORA_CUSTOM_LLM_URL", required=False)
    if explicit:
        return explicit
    base = _public_base_url()
    return f"{base}/api/agora_chat" if base else ""


def _build_llm(provider: str | None) -> dict[str, Any]:
    url = _custom_llm_url()
    selected = "gemini" if str(provider or "").lower() == "gemini" else "openai"
    model = _env("SHENGWANG_CUSTOM_LLM_MODEL", "AGORA_CUSTOM_LLM_MODEL", required=False) or selected
    if not url:
        raise HTTPException(status_code=503, detail="无法确定声网自定义 LLM 公网 URL；请配置 LABSIGHT_PUBLIC_BASE_URL")
    return {
        "vendor": "custom",
        "url": url,
        "api_key": _env("SHENGWANG_CUSTOM_LLM_API_KEY", "AGORA_CUSTOM_LLM_API_KEY", required=False) or _app_cert(),
        "system_messages": [{
            "role": "system",
            "content": "你是 LabSight 实时硬件调试助手。使用简体中文，先直接回答用户问题，再给必要下一步；不要重复问题，不要猜测当前不可见画面。",
        }],
        "greeting_message": "LabSight 已连接，我在听。",
        "failure_message": "这个问题我暂时没有判断清楚，请再说一次。",
        "max_history": 12,
        "params": {
            "model": model,
            "stream": True,
            "temperature": _env_float("SHENGWANG_LLM_TEMPERATURE", 0.3),
            "max_tokens": _env_int("SHENGWANG_LLM_MAX_TOKENS", 220),
        },
    }


def _tts_target(value: str | None) -> str:
    target = (value or "gemini").strip().lower()
    if target not in {"gemini", "probe"}:
        raise HTTPException(status_code=400, detail="tts_target 仅支持 gemini 或 probe")
    return target


def _tts_mode() -> str:
    mode = os.getenv("SHENGWANG_TTS_MODE", "generic_http").strip().lower()
    if mode != "generic_http":
        raise HTTPException(status_code=500, detail="当前 LabSight EVT 仅启用 generic_http/Gemini TTS")
    return mode


def _tts_url(target: str) -> str:
    if target == "gemini":
        explicit = os.getenv("SHENGWANG_TTS_URL", "").strip()
        if explicit:
            return explicit
    base = _public_base_url()
    if not base:
        return ""
    return f"{base}/api/tts_probe" if target == "probe" else f"{base}/api/gemini_tts_openai"


def _build_tts(target: str) -> dict[str, Any]:
    _tts_mode()
    if target == "gemini" and not os.getenv("GEMINI_API_KEY", "").strip():
        raise HTTPException(status_code=503, detail="Gemini GenericTTS 需要 GEMINI_API_KEY")
    url = _tts_url(target)
    if not url:
        raise HTTPException(status_code=503, detail="无法确定 GenericTTS 公网 URL")
    params: dict[str, Any] = {
        "model": "labsight-tts-probe" if target == "probe" else os.getenv("GEMINI_TTS_MODEL", "gemini-3.1-flash-tts-preview"),
        "voice": "probe" if target == "probe" else os.getenv("GEMINI_TTS_VOICE", "Kore"),
        "speed": 1.0,
        "sample_rate": 24000,
        "response_format": "pcm",
    }
    if target == "gemini":
        params["instruction"] = os.getenv("SHENGWANG_TTS_INSTRUCTION", "使用自然、清晰、专业但简洁的普通话播报。")
    tts: dict[str, Any] = {"vendor": "generic_http", "url": url, "params": params}
    key = os.getenv("SHENGWANG_CUSTOM_TTS_API_KEY", "").strip()
    if key and target == "gemini":
        tts["headers"] = {"Authorization": f"Bearer {key}"}
    return tts


def _request(method: str, url: str, body: dict[str, Any] | None = None, timeout: int = 25) -> requests.Response:
    try:
        response = requests.request(
            method,
            url,
            headers={"Authorization": _auth(), "Content-Type": "application/json"},
            json=body,
            timeout=timeout,
        )
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"声网请求失败：{exc}") from exc
    if response.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"声网 API {response.status_code}: {response.text[:1800]}")
    return response


def _start(req: ShengwangSessionRequest) -> dict[str, Any]:
    app_id, app_cert = _app_id(), _app_cert()
    channel = req.channel or f"{os.getenv('SHENGWANG_CHANNEL_PREFIX', 'labsight-voice')}-{uuid.uuid4().hex[:10]}"
    user_uid = random.randint(100000, 999999)
    agent_uid = random.randint(1_000_000, 1_999_999)
    while agent_uid == user_uid:
        agent_uid = random.randint(1_000_000, 1_999_999)

    target = _tts_target(req.tts_target)
    threshold = min(0.95, max(0.05, _env_float("SHENGWANG_SPEECH_THRESHOLD", 0.20)))
    sos_ms = max(120, min(1200, _env_int("SHENGWANG_INTERRUPT_MS", 160)))
    speaking_sos_ms = max(120, min(1200, _env_int("SHENGWANG_SPEAKING_INTERRUPT_MS", 220)))
    prefix_ms = max(0, min(5000, _env_int("SHENGWANG_PREFIX_PADDING_MS", 800)))
    eos_mode = os.getenv("SHENGWANG_EOS_MODE", "vad").strip().lower()
    if eos_mode not in {"vad", "semantic"}:
        eos_mode = "vad"
    silence_ms = max(120, min(2000, _env_int("SHENGWANG_VAD_SILENCE_MS", 600)))
    semantic_silence_ms = max(120, min(2000, _env_int("SHENGWANG_SEMANTIC_SILENCE_MS", 240)))
    max_wait_ms = max(300, _env_int("SHENGWANG_SEMANTIC_MAX_WAIT_MS", 3000))

    end_of_speech: dict[str, Any]
    if eos_mode == "semantic":
        end_of_speech = {
            "mode": "semantic",
            "semantic_config": {
                "silence_duration_ms": semantic_silence_ms,
                "max_wait_ms": max_wait_ms,
                "pause_state_enabled": True,
            },
        }
    else:
        end_of_speech = {"mode": "vad", "vad_config": {"silence_duration_ms": silence_ms}}

    properties: dict[str, Any] = {
        "channel": channel,
        "token": _rtc_token(app_id, app_cert, channel, agent_uid),
        "agent_rtc_uid": str(agent_uid),
        "remote_rtc_uids": [str(user_uid)],
        "enable_string_uid": False,
        "idle_timeout": _env_int("SHENGWANG_IDLE_TIMEOUT", 180),
        "asr": {
            "language": os.getenv("SHENGWANG_ASR_LANGUAGE", "zh-CN"),
            "vendor": os.getenv("SHENGWANG_ASR_VENDOR", "fengming"),
        },
        "turn_detection": {
            "mode": "default",
            "config": {
                "speech_threshold": threshold,
                "start_of_speech": {
                    "mode": "vad",
                    "vad_config": {
                        "interrupt_duration_ms": sos_ms,
                        "speaking_interrupt_duration_ms": speaking_sos_ms,
                        "prefix_padding_ms": prefix_ms,
                    },
                },
                "end_of_speech": end_of_speech,
            },
        },
        "interruption": {"enable": True, "mode": "start_of_speech"},
        "llm": _build_llm(req.provider),
        "tts": _build_tts(target),
        "parameters": {
            "data_channel": "datastream",
            "enable_error_message": True,
            "audio_scenario": "default",
        },
    }

    payload = {"name": f"labsight-{target}-{uuid.uuid4().hex[:10]}", "properties": properties}
    response = _request("POST", f"{API_BASE}/{app_id}/join", payload)
    data = response.json()
    if data.get("status") == "FAILED":
        raise HTTPException(status_code=502, detail=f"声网智能体启动失败：{data}")

    return {
        "ok": True,
        "mode": "shengwang_realtime_voice",
        "app_id": app_id,
        "channel": channel,
        "uid": user_uid,
        "rtc_token": _rtc_token(app_id, app_cert, channel, user_uid),
        "agent_uid": agent_uid,
        "agent_id": data.get("agent_id"),
        "agent_status": data.get("status", "UNKNOWN"),
        "asr": {"vendor": properties["asr"]["vendor"], "language": properties["asr"]["language"]},
        "turn_detection": {
            "speech_threshold": threshold,
            "sos_ms": sos_ms,
            "prefix_ms": prefix_ms,
            "eos_mode": eos_mode,
            "silence_ms": silence_ms if eos_mode == "vad" else semantic_silence_ms,
        },
        "tts": {"vendor": "generic_http", "target": target, "url": _tts_url(target)},
    }


def _agent_action(req: ShengwangSessionRequest, endpoint: str, body: dict[str, Any]) -> dict[str, Any]:
    if not req.agent_id:
        raise HTTPException(status_code=400, detail="缺少 agent_id")
    response = _request("POST", f"{API_BASE}/{_app_id()}/agents/{req.agent_id}/{endpoint}", body)
    try:
        data = response.json()
    except Exception:
        data = {}
    return {"ok": True, "agent_id": req.agent_id, "response": data}


@app.get("/api/shengwang_session")
def health() -> dict[str, Any]:
    missing = []
    for key in ["SHENGWANG_APP_ID", "SHENGWANG_APP_CERTIFICATE", "SHENGWANG_CUSTOMER_ID", "SHENGWANG_CUSTOMER_SECRET"]:
        if not os.getenv(key, "").strip() and not os.getenv(key.replace("SHENGWANG_", "AGORA_"), "").strip():
            missing.append(key)
    if not os.getenv("GEMINI_API_KEY", "").strip():
        missing.append("GEMINI_API_KEY")
    return {
        "ok": True,
        "service": "labsight-shengwang-session",
        "version": "0.10.9",
        "configured": not missing,
        "missing": missing,
        "tts_mode": "generic_http",
        "speech_threshold": min(0.95, max(0.05, _env_float("SHENGWANG_SPEECH_THRESHOLD", 0.20))),
        "eos_mode": os.getenv("SHENGWANG_EOS_MODE", "vad"),
        "gemini_tts_url": _tts_url("gemini"),
        "probe_tts_url": _tts_url("probe"),
    }


@app.post("/api/shengwang_session")
def action(req: ShengwangSessionRequest) -> JSONResponse:
    action_name = (req.action or "start").strip().lower()
    if action_name == "start":
        return JSONResponse(_start(req))
    if action_name == "stop":
        if not req.agent_id:
            return JSONResponse({"ok": True, "stopped": False})
        return JSONResponse(_agent_action(req, "leave", {}))
    if action_name == "interrupt":
        return JSONResponse(_agent_action(req, "interrupt", {}))
    if action_name == "speak":
        text = (req.text or "LabSight 实时语音连接成功。你可以开始说话。").strip()
        return JSONResponse(_agent_action(req, "speak", {"text": text}))
    raise HTTPException(status_code=400, detail=f"未知 action: {req.action}")
