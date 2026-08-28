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

app = FastAPI(title="LabSight Shengwang Voice Adapter", version="0.10.5")
API_BASE = "https://api.agora.io/cn/api/conversational-ai-agent/v2/projects"


class ShengwangSessionRequest(BaseModel):
    action: str = "start"
    agent_id: str | None = None
    channel: str | None = None
    provider: str | None = None
    text: str | None = None


def _first_env(*names: str, required: bool = True) -> str:
    for name in names:
        value = os.getenv(name, "").strip()
        if value:
            return value
    if required:
        raise HTTPException(status_code=503, detail=f"未配置 {' / '.join(names)}")
    return ""


def _app_id() -> str:
    return _first_env("SHENGWANG_APP_ID", "AGORA_APP_ID")


def _app_cert() -> str:
    return _first_env("SHENGWANG_APP_CERTIFICATE", "AGORA_APP_CERTIFICATE")


def _basic_auth_header() -> str:
    customer_id = _first_env("SHENGWANG_CUSTOMER_ID", "AGORA_CUSTOMER_ID")
    customer_secret = _first_env("SHENGWANG_CUSTOMER_SECRET", "AGORA_CUSTOMER_SECRET")
    raw = f"{customer_id}:{customer_secret}".encode("utf-8")
    return "Basic " + base64.b64encode(raw).decode("ascii")


def _pack_u16(value: int) -> bytes:
    return struct.pack("<H", int(value))


def _pack_u32(value: int) -> bytes:
    return struct.pack("<I", int(value))


def _pack_string(value: bytes) -> bytes:
    return _pack_u16(len(value)) + value


def _pack_privileges(values: dict[int, int]) -> bytes:
    ordered = sorted(values.items(), key=lambda item: item[0])
    return _pack_u16(len(ordered)) + b"".join(_pack_u16(k) + _pack_u32(v) for k, v in ordered)


def _validate_agora_secret(name: str, value: str) -> None:
    if len(value) != 32:
        raise HTTPException(status_code=500, detail=f"{name} 长度应为 32 个十六进制字符")
    try:
        bytes.fromhex(value)
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=f"{name} 不是有效的十六进制字符串") from exc


def _rtc_token(app_id: str, app_cert: str, channel: str, uid: int, ttl: int = 3600) -> str:
    """Generate Agora AccessToken2 / Token007 using the official wire format."""
    _validate_agora_secret("SHENGWANG_APP_ID", app_id)
    _validate_agora_secret("SHENGWANG_APP_CERTIFICATE", app_cert)
    if not channel or len(channel.encode("utf-8")) >= 64:
        raise HTTPException(status_code=500, detail="声网 channel 必须为 1~63 字节")
    if uid < 0 or uid > 0xFFFFFFFF:
        raise HTTPException(status_code=500, detail="声网 RTC uid 必须在 0~2^32-1 范围内")

    issue_ts = int(time.time())
    salt = random.randint(1, 99_999_999)
    privilege_expire = max(1, int(ttl))
    service = (
        _pack_u16(1)
        + _pack_privileges({1: privilege_expire, 2: privilege_expire, 3: privilege_expire, 4: privilege_expire})
        + _pack_string(channel.encode("utf-8"))
        + _pack_string(b"" if uid == 0 else str(uid).encode("utf-8"))
    )

    cert_bytes = app_cert.encode("utf-8")
    signing = hmac.new(_pack_u32(issue_ts), cert_bytes, sha256).digest()
    signing = hmac.new(_pack_u32(salt), signing, sha256).digest()
    signing_info = (
        _pack_string(app_id.encode("utf-8"))
        + _pack_u32(issue_ts)
        + _pack_u32(max(1, int(ttl)))
        + _pack_u32(salt)
        + _pack_u16(1)
        + service
    )
    signature = hmac.new(signing, signing_info, sha256).digest()
    return "007" + base64.b64encode(zlib.compress(_pack_string(signature) + signing_info)).decode("ascii")


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
    explicit = _first_env("SHENGWANG_CUSTOM_LLM_URL", "AGORA_CUSTOM_LLM_URL", required=False)
    if explicit:
        return explicit
    base = _public_base_url()
    return base + "/api/agora_chat" if base else ""


def _custom_llm_key() -> str:
    return _first_env("SHENGWANG_CUSTOM_LLM_API_KEY", "AGORA_CUSTOM_LLM_API_KEY", required=False) or _app_cert()


def _custom_tts_url() -> str:
    explicit = os.getenv("SHENGWANG_TTS_URL", "").strip()
    if explicit:
        return explicit
    base = _public_base_url()
    return base + "/api/gemini_tts_openai" if base else ""


def _env_float(name: str, fallback_name: str | None, default: float) -> float:
    raw = os.getenv(name, "").strip() or (os.getenv(fallback_name, "").strip() if fallback_name else "")
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=f"环境变量 {name} 不是有效数字：{raw}") from exc


def _env_int(name: str, fallback_name: str | None, default: int) -> int:
    raw = os.getenv(name, "").strip() or (os.getenv(fallback_name, "").strip() if fallback_name else "")
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=f"环境变量 {name} 不是有效整数：{raw}") from exc


def _llm_params(model: str) -> dict[str, Any]:
    return {
        "model": model,
        "stream": True,
        "temperature": _env_float("SHENGWANG_LLM_TEMPERATURE", "AGORA_LLM_TEMPERATURE", 0.3),
        "max_tokens": _env_int("SHENGWANG_LLM_MAX_TOKENS", "AGORA_LLM_MAX_TOKENS", 220),
    }


def _build_llm(provider: str | None) -> dict[str, Any]:
    url = _custom_llm_url()
    selected = "gemini" if str(provider or "").lower() == "gemini" else "openai"
    model = _first_env("SHENGWANG_CUSTOM_LLM_MODEL", "AGORA_CUSTOM_LLM_MODEL", required=False) or selected
    if url:
        return {
            "vendor": "custom",
            "url": url,
            "api_key": _custom_llm_key(),
            "system_messages": [{
                "role": "system",
                "content": (
                    "你是 LabSight 实时硬件调试助手。始终使用简体中文，先给直接结论，再给必要的下一步。"
                    "不要长篇播报，不要重复用户问题。器件型号、位号、引脚、网络名、协议和单位保持原样。"
                    "当前语音通道如缺少当前画面或 KiCad 上下文，应明确说明需要视觉/工程文件证据，不要猜测。"
                ),
            }],
            "greeting_message": "LabSight 已连接，我在听。",
            "failure_message": "这个问题我暂时没有判断清楚，请再说一次。",
            "max_history": 12,
            "params": _llm_params(model),
        }
    return {
        "vendor": os.getenv("SHENGWANG_LLM_VENDOR", os.getenv("AGORA_LLM_VENDOR", "deepseek")),
        "url": os.getenv("SHENGWANG_LLM_URL", os.getenv("AGORA_LLM_URL", "")),
        "api_key": os.getenv("SHENGWANG_LLM_API_KEY", ""),
        "system_messages": [{"role": "system", "content": "你是 LabSight 实时硬件调试助手，始终用简体中文简洁回答。"}],
        "greeting_message": "LabSight 已连接，我在听。",
        "failure_message": "这个问题我暂时没有判断清楚，请再说一次。",
        "max_history": 12,
        "params": _llm_params(os.getenv("SHENGWANG_LLM_MODEL", os.getenv("AGORA_LLM_MODEL", "deepseek-chat"))),
    }


def _build_tts() -> dict[str, Any]:
    if not os.getenv("GEMINI_API_KEY", "").strip():
        raise HTTPException(status_code=503, detail="未配置 GEMINI_API_KEY")
    url = _custom_tts_url()
    if not url:
        raise HTTPException(status_code=503, detail="无法确定 Gemini TTS Bridge 地址，请配置 LABSIGHT_PUBLIC_BASE_URL 或 SHENGWANG_TTS_URL")
    params: dict[str, Any] = {
        "url": url,
        "model": os.getenv("GEMINI_TTS_MODEL", "gemini-3.1-flash-tts-preview"),
        "voice": os.getenv("GEMINI_TTS_VOICE", "Kore"),
        "sample_rate": 24000,
        "response_format": "pcm",
        "instruction": os.getenv("SHENGWANG_TTS_INSTRUCTION", "使用自然、清晰、专业但简洁的普通话播报，技术型号和单位准确朗读。"),
    }
    custom_key = os.getenv("SHENGWANG_CUSTOM_TTS_API_KEY", "").strip()
    if custom_key:
        params["api_key"] = custom_key
    return {"vendor": "generic_http", "params": params}


def _request(method: str, url: str, *, json_body: dict[str, Any] | None = None, timeout: int = 25) -> requests.Response:
    try:
        response = requests.request(
            method,
            url,
            headers={"Authorization": _basic_auth_header(), "Content-Type": "application/json"},
            json=json_body,
            timeout=timeout,
        )
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"声网请求失败：{exc}") from exc
    if response.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"声网 API {response.status_code}: {response.text[:1800]}")
    return response


def _start(req: ShengwangSessionRequest) -> dict[str, Any]:
    app_id = _app_id()
    app_cert = _app_cert()
    prefix = os.getenv("SHENGWANG_CHANNEL_PREFIX", "labsight-voice")
    channel = req.channel or f"{prefix}-{uuid.uuid4().hex[:10]}"
    user_uid = random.randint(100000, 999999)

    configured_agent_uid = _env_int("SHENGWANG_AGENT_UID", None, 0)
    # Avoid the special UID=0/random-assignment path while debugging the RTC chain.
    agent_uid = configured_agent_uid if configured_agent_uid > 0 else random.randint(1_000_000, 1_999_999)
    while agent_uid == user_uid:
        agent_uid = random.randint(1_000_000, 1_999_999)

    user_token = _rtc_token(app_id, app_cert, channel, user_uid)
    agent_token = _rtc_token(app_id, app_cert, channel, agent_uid)

    silence_ms = _env_int("SHENGWANG_SEMANTIC_SILENCE_MS", None, 240)
    max_wait_ms = _env_int("SHENGWANG_SEMANTIC_MAX_WAIT_MS", None, 3000)
    interrupt_ms = _env_int("SHENGWANG_INTERRUPT_MS", None, 180)
    speaking_interrupt_ms = _env_int("SHENGWANG_SPEAKING_INTERRUPT_MS", None, 220)

    properties: dict[str, Any] = {
        "channel": channel,
        "token": agent_token,
        "agent_rtc_uid": str(agent_uid),
        "remote_rtc_uids": [str(user_uid)],
        "enable_string_uid": False,
        "idle_timeout": _env_int("SHENGWANG_IDLE_TIMEOUT", None, 180),
        "asr": {
            "language": os.getenv("SHENGWANG_ASR_LANGUAGE", "zh-CN"),
            "vendor": os.getenv("SHENGWANG_ASR_VENDOR", "fengming"),
            "keywords": ["LabSight", "ezPLM", "KiCad", "PCB", "FPGA", "RP2040", "RP2350", "ADALM2000", "示波器", "逻辑分析仪", "信号发生器", "电源纹波", "焊点", "丝印", "位号"],
        },
        "turn_detection": {
            "mode": "default",
            "config": {
                "start_of_speech": {
                    "mode": "vad",
                    "vad_config": {
                        "interrupt_duration_ms": interrupt_ms,
                        "speaking_interrupt_duration_ms": speaking_interrupt_ms,
                        "prefix_padding_ms": _env_int("SHENGWANG_PREFIX_PADDING_MS", None, 600),
                    },
                },
                "end_of_speech": {
                    "mode": "semantic",
                    "semantic_config": {"silence_duration_ms": silence_ms, "max_wait_ms": max_wait_ms},
                },
            },
        },
        "interruption": {"enable": True, "mode": "start_of_speech"},
        "llm": _build_llm(req.provider),
        "tts": _build_tts(),
        "parameters": {"data_channel": "datastream"},
    }

    payload = {"name": f"labsight-{uuid.uuid4().hex[:12]}", "properties": properties}
    response = _request("POST", f"{API_BASE}/{app_id}/join", json_body=payload)
    try:
        data = response.json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"声网创建智能体返回了非 JSON：{response.text[:1200]}") from exc

    status = data.get("status", "UNKNOWN")
    if status == "FAILED":
        raise HTTPException(status_code=502, detail=f"声网智能体启动后立即失败：{data}")

    return {
        "ok": True,
        "mode": "shengwang_realtime_voice",
        "app_id": app_id,
        "channel": channel,
        "uid": user_uid,
        "rtc_token": user_token,
        "agent_uid": agent_uid,
        "agent_id": data.get("agent_id"),
        "agent_status": status,
        "turn_detection": {"mode": "semantic", "silence_ms": silence_ms, "max_wait_ms": max_wait_ms},
        "asr": {"vendor": os.getenv("SHENGWANG_ASR_VENDOR", "fengming"), "language": os.getenv("SHENGWANG_ASR_LANGUAGE", "zh-CN")},
        "tts": {"vendor": "generic_http", "provider": "gemini", "model": os.getenv("GEMINI_TTS_MODEL", "gemini-3.1-flash-tts-preview"), "voice": os.getenv("GEMINI_TTS_VOICE", "Kore"), "sample_rate": 24000},
    }


def _stop(req: ShengwangSessionRequest) -> dict[str, Any]:
    if not req.agent_id:
        return {"ok": True, "stopped": False, "reason": "missing_agent_id"}
    response = _request("POST", f"{API_BASE}/{_app_id()}/agents/{req.agent_id}/leave", json_body={})
    try:
        data = response.json()
    except Exception:
        data = {}
    return {"ok": True, "stopped": True, "agent_id": req.agent_id, "response": data}


def _interrupt(req: ShengwangSessionRequest) -> dict[str, Any]:
    if not req.agent_id:
        raise HTTPException(status_code=400, detail="缺少 agent_id")
    response = _request("POST", f"{API_BASE}/{_app_id()}/agents/{req.agent_id}/interrupt", json_body={})
    try:
        data = response.json()
    except Exception:
        data = {}
    return {"ok": True, "interrupted": True, "agent_id": req.agent_id, "response": data}


def _speak(req: ShengwangSessionRequest) -> dict[str, Any]:
    if not req.agent_id:
        raise HTTPException(status_code=400, detail="缺少 agent_id")
    text = (req.text or "LabSight 实时语音连接成功。你可以开始说话。").strip()
    if not text:
        raise HTTPException(status_code=400, detail="缺少播报文本")
    response = _request(
        "POST",
        f"{API_BASE}/{_app_id()}/agents/{req.agent_id}/speak",
        json_body={"text": text, "priority": "INTERRUPT", "interruptable": True},
    )
    try:
        data = response.json()
    except Exception:
        data = {}
    return {"ok": True, "spoken": True, "agent_id": req.agent_id, "response": data}


@app.get("/api/shengwang_session")
def shengwang_session_health():
    missing = []
    for name in ("SHENGWANG_APP_ID", "SHENGWANG_APP_CERTIFICATE", "SHENGWANG_CUSTOMER_ID", "SHENGWANG_CUSTOMER_SECRET", "GEMINI_API_KEY"):
        if not os.getenv(name, "").strip():
            missing.append(name)
    return {
        "ok": True,
        "service": "shengwang-session",
        "version": "0.10.5",
        "configured": not missing,
        "missing": missing,
        "token_builder": "builtin-access-token2",
        "diagnostic_speak": True,
        "tts": {
            "vendor": "generic_http",
            "provider": "gemini",
            "model": os.getenv("GEMINI_TTS_MODEL", "gemini-3.1-flash-tts-preview"),
            "voice": os.getenv("GEMINI_TTS_VOICE", "Kore"),
            "sample_rate": 24000,
            "url": _custom_tts_url() or None,
        },
    }


@app.post("/api/shengwang_session")
def shengwang_session(req: ShengwangSessionRequest):
    try:
        action = req.action.strip().lower()
        if action == "start":
            return _start(req)
        if action == "stop":
            return _stop(req)
        if action == "interrupt":
            return _interrupt(req)
        if action == "speak":
            return _speak(req)
        raise HTTPException(status_code=400, detail="action 仅支持 start/stop/interrupt/speak")
    except HTTPException:
        raise
    except Exception as exc:
        return JSONResponse(status_code=500, content={"ok": False, "detail": f"声网会话内部错误：{type(exc).__name__}: {exc}"})
