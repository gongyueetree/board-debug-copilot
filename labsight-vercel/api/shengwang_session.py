from __future__ import annotations

import base64
import os
import random
import time
import uuid
from typing import Any

import requests
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from agora_token_builder import RtcTokenBuilder

app = FastAPI(title="LabSight Shengwang Voice Adapter", version="0.10.1")

API_BASE = "https://api.agora.io/cn/api/conversational-ai-agent/v2/projects"


class ShengwangSessionRequest(BaseModel):
    action: str = "start"
    agent_id: str | None = None
    channel: str | None = None
    provider: str | None = None


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


def _rtc_token(app_id: str, app_cert: str, channel: str, uid: int, ttl: int = 3600) -> str:
    expire_ts = int(time.time()) + ttl
    return RtcTokenBuilder.buildTokenWithUid(app_id, app_cert, channel, uid, 1, expire_ts)


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
    return (
        _first_env("SHENGWANG_CUSTOM_LLM_API_KEY", "AGORA_CUSTOM_LLM_API_KEY", required=False)
        or _app_cert()
    )


def _llm_params(model: str) -> dict[str, Any]:
    return {
        "model": model,
        "stream": True,
        "temperature": float(os.getenv("SHENGWANG_LLM_TEMPERATURE", os.getenv("AGORA_LLM_TEMPERATURE", "0.3"))),
        "max_tokens": int(os.getenv("SHENGWANG_LLM_MAX_TOKENS", os.getenv("AGORA_LLM_MAX_TOKENS", "220"))),
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
            "system_messages": [
                {
                    "role": "system",
                    "content": (
                        "你是 LabSight 实时硬件调试助手。始终使用简体中文，先给直接结论，再给必要的下一步。"
                        "不要长篇播报，不要重复用户问题。器件型号、位号、引脚、网络名、协议和单位保持原样。"
                        "当前语音通道如缺少当前画面或 KiCad 上下文，应明确说明需要视觉/工程文件证据，不要猜测。"
                    ),
                }
            ],
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
    vendor = os.getenv("SHENGWANG_TTS_VENDOR", os.getenv("AGORA_TTS_VENDOR", "minimax")).strip().lower()
    model = os.getenv("SHENGWANG_TTS_MODEL", os.getenv("AGORA_TTS_MODEL", "speech-2.6-turbo"))
    if vendor == "minimax":
        key = os.getenv("SHENGWANG_TTS_API_KEY", "").strip()
        params: dict[str, Any] = {
            "key": key,
            "model": model,
            "voice_setting": {
                "voice_id": os.getenv("SHENGWANG_TTS_VOICE_ID", "female-shaonv"),
                "speed": float(os.getenv("SHENGWANG_TTS_SPEED", "1.05")),
                "vol": 1,
                "pitch": 0,
            },
            "audio_setting": {"sample_rate": int(os.getenv("SHENGWANG_TTS_SAMPLE_RATE", "16000"))},
        }
        group_id = os.getenv("SHENGWANG_TTS_GROUP_ID", "").strip()
        if group_id:
            params["group_id"] = group_id
        return {"vendor": "minimax", "params": params}
    return {
        "vendor": vendor,
        "params": {
            "url": os.getenv("SHENGWANG_TTS_URL", ""),
            "key": os.getenv("SHENGWANG_TTS_API_KEY", ""),
            "model": model,
            "voice": os.getenv("SHENGWANG_TTS_VOICE", ""),
        },
    }


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
    agent_uid = int(os.getenv("SHENGWANG_AGENT_UID", "0"))
    user_token = _rtc_token(app_id, app_cert, channel, user_uid)
    agent_token = _rtc_token(app_id, app_cert, channel, agent_uid)

    silence_ms = int(os.getenv("SHENGWANG_SEMANTIC_SILENCE_MS", "240"))
    max_wait_ms = int(os.getenv("SHENGWANG_SEMANTIC_MAX_WAIT_MS", "3000"))
    interrupt_ms = int(os.getenv("SHENGWANG_INTERRUPT_MS", "180"))
    speaking_interrupt_ms = int(os.getenv("SHENGWANG_SPEAKING_INTERRUPT_MS", "220"))

    properties: dict[str, Any] = {
        "channel": channel,
        "token": agent_token,
        "agent_rtc_uid": str(agent_uid),
        "remote_rtc_uids": [str(user_uid)],
        "enable_string_uid": False,
        "idle_timeout": int(os.getenv("SHENGWANG_IDLE_TIMEOUT", "180")),
        "asr": {
            "language": "zh-CN",
            "vendor": "fengming",
            "keywords": [
                "LabSight", "ezPLM", "KiCad", "PCB", "FPGA", "RP2040", "RP2350", "ADALM2000",
                "示波器", "逻辑分析仪", "信号发生器", "电源纹波", "焊点", "丝印", "位号",
            ],
        },
        "turn_detection": {
            "mode": "default",
            "config": {
                "start_of_speech": {
                    "mode": "vad",
                    "vad_config": {
                        "interrupt_duration_ms": interrupt_ms,
                        "speaking_interrupt_duration_ms": speaking_interrupt_ms,
                        "prefix_padding_ms": int(os.getenv("SHENGWANG_PREFIX_PADDING_MS", "600")),
                    },
                },
                "end_of_speech": {
                    "mode": "semantic",
                    "semantic_config": {
                        "silence_duration_ms": silence_ms,
                        "max_wait_ms": max_wait_ms,
                    },
                },
            },
        },
        "interruption": {
            "enable": True,
            "mode": "start_of_speech",
        },
        "llm": _build_llm(req.provider),
        "tts": _build_tts(),
        "parameters": {
            "data_channel": "datastream",
        },
    }

    payload = {"name": f"labsight-{uuid.uuid4().hex[:12]}", "properties": properties}
    response = _request("POST", f"{API_BASE}/{app_id}/join", json_body=payload)
    data = response.json()
    return {
        "ok": True,
        "mode": "shengwang_realtime_voice",
        "app_id": app_id,
        "channel": channel,
        "uid": user_uid,
        "rtc_token": user_token,
        "agent_uid": agent_uid,
        "agent_id": data.get("agent_id"),
        "agent_status": data.get("status", "RUNNING"),
        "turn_detection": {"mode": "semantic", "silence_ms": silence_ms, "max_wait_ms": max_wait_ms},
        "asr": {"vendor": "fengming", "language": "zh-CN"},
    }


def _stop(req: ShengwangSessionRequest) -> dict[str, Any]:
    if not req.agent_id:
        return {"ok": True, "stopped": False, "reason": "missing_agent_id"}
    app_id = _app_id()
    response = _request("POST", f"{API_BASE}/{app_id}/agents/{req.agent_id}/leave", json_body={})
    try:
        data = response.json()
    except Exception:
        data = {}
    return {"ok": True, "stopped": True, "agent_id": req.agent_id, "response": data}


def _interrupt(req: ShengwangSessionRequest) -> dict[str, Any]:
    if not req.agent_id:
        raise HTTPException(status_code=400, detail="缺少 agent_id")
    app_id = _app_id()
    response = _request("POST", f"{API_BASE}/{app_id}/agents/{req.agent_id}/interrupt", json_body={})
    try:
        data = response.json()
    except Exception:
        data = {}
    return {"ok": True, "interrupted": True, "agent_id": req.agent_id, "response": data}


@app.post("/api/shengwang_session")
def shengwang_session(req: ShengwangSessionRequest):
    action = req.action.strip().lower()
    if action == "start":
        return _start(req)
    if action == "stop":
        return _stop(req)
    if action == "interrupt":
        return _interrupt(req)
    raise HTTPException(status_code=400, detail="action 仅支持 start/stop/interrupt")
