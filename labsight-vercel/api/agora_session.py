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

app = FastAPI(title="LabSight Agora Voice Adapter", version="0.8.2")


class AgoraSessionRequest(BaseModel):
    action: str = "start"
    agent_id: str | None = None
    channel: str | None = None
    provider: str | None = None


def _env(name: str, required: bool = True) -> str:
    value = os.getenv(name, "").strip()
    if required and not value:
        raise HTTPException(status_code=503, detail=f"未配置 {name}")
    return value


def _basic_auth_header() -> str:
    customer_id = _env("AGORA_CUSTOMER_ID")
    customer_secret = _env("AGORA_CUSTOMER_SECRET")
    raw = f"{customer_id}:{customer_secret}".encode("utf-8")
    return "Basic " + base64.b64encode(raw).decode("ascii")


def _rtc_token(app_id: str, app_cert: str, channel: str, uid: int, ttl: int = 3600) -> str:
    expire_ts = int(time.time()) + ttl
    return RtcTokenBuilder.buildTokenWithUid(app_id, app_cert, channel, uid, 1, expire_ts)


def _llm_params(model: str) -> dict[str, Any]:
    return {
        "model": model,
        "stream": True,
        "temperature": float(os.getenv("AGORA_LLM_TEMPERATURE", "0.35")),
        "max_tokens": int(os.getenv("AGORA_LLM_MAX_TOKENS", "220")),
    }


def _custom_llm_url() -> str:
    explicit = os.getenv("AGORA_CUSTOM_LLM_URL", "").strip()
    if explicit:
        return explicit
    host = (
        os.getenv("LABSIGHT_PUBLIC_BASE_URL", "").strip()
        or os.getenv("VERCEL_URL", "").strip()
        or os.getenv("VERCEL_PROJECT_PRODUCTION_URL", "").strip()
    )
    if not host:
        return ""
    if not host.startswith(("http://", "https://")):
        host = "https://" + host
    return host.rstrip("/") + "/api/agora_chat"


def _custom_llm_key() -> str:
    return os.getenv("AGORA_CUSTOM_LLM_API_KEY", "").strip() or os.getenv("AGORA_APP_CERTIFICATE", "").strip()


def _build_llm_block(provider: str | None) -> dict[str, Any]:
    custom_url = _custom_llm_url()
    if custom_url:
        selected = "gemini" if str(provider or "").lower() == "gemini" else "openai"
        model = os.getenv("AGORA_CUSTOM_LLM_MODEL", "").strip() or selected
        # Match Agora's documented custom LLM REST shape: url + api_key + OpenAI-style params.
        return {
            "url": custom_url,
            "api_key": _custom_llm_key(),
            "system_messages": [
                {
                    "role": "system",
                    "content": (
                        "你是 LabSight 实时语音调试助手。始终使用简体中文回答，表达简洁、自然、工程化。"
                        "器件型号、网络名、引脚名和单位保持原样。当前 EVT0.8 语音通道以实时对话为主；"
                        "若问题必须依赖当前摄像头画面，应明确提示用户使用页面的画面分析或 PCB Deep Vision。"
                    ),
                }
            ],
            "greeting_message": "LabSight 实时语音已连接，我在听。",
            "failure_message": "这个问题我暂时没有判断清楚，可以换一种说法或结合当前画面再试一次。",
            "max_history": 12,
            "params": _llm_params(model),
        }

    return {
        "credential_mode": "managed",
        "vendor": os.getenv("AGORA_LLM_VENDOR", "openai"),
        "style": "openai",
        "url": os.getenv("AGORA_LLM_URL", "https://api.openai.com/v1/chat/completions"),
        "system_messages": [
            {
                "role": "system",
                "content": (
                    "你是 LabSight 实时语音调试助手。始终用简体中文自然、简洁地回答。"
                    "面向电子研发工程师，不要长篇播报。器件型号、引脚和单位保持原样。"
                    "回答优先控制在 2~5 句话，先给结论，再给下一步。"
                ),
            }
        ],
        "greeting_message": "LabSight 实时语音已连接，我在听。",
        "failure_message": "这个问题我暂时没有判断清楚，请再说一次。",
        "max_history": 12,
        "params": _llm_params(os.getenv("AGORA_LLM_MODEL", "gpt-4o-mini")),
    }


def _build_tts_block() -> dict[str, Any]:
    vendor = os.getenv("AGORA_TTS_VENDOR", "minimax").strip().lower()
    if vendor == "openai":
        return {
            "credential_mode": "managed",
            "vendor": "openai",
            "params": {
                "url": "https://api.openai.com/v1/audio/speech",
                "model": os.getenv("AGORA_TTS_MODEL", "tts-1"),
                "voice": os.getenv("AGORA_TTS_VOICE", "alloy"),
            },
        }
    params: dict[str, Any] = {
        "url": "wss://api.minimax.io/ws/v1/t2a_v2",
        "model": os.getenv("AGORA_TTS_MODEL", "speech-2.6-turbo"),
    }
    voice_id = os.getenv("AGORA_TTS_VOICE_ID", "").strip()
    if voice_id:
        params["voice_setting"] = {"voice_id": voice_id}
    return {"credential_mode": "managed", "vendor": "minimax", "params": params}


def _start_session(req: AgoraSessionRequest) -> dict[str, Any]:
    app_id = _env("AGORA_APP_ID")
    app_cert = _env("AGORA_APP_CERTIFICATE")
    channel_prefix = os.getenv("AGORA_CHANNEL_PREFIX", "labsight-evt08")
    channel = req.channel or f"{channel_prefix}-{uuid.uuid4().hex[:10]}"
    user_uid = random.randint(100000, 999999)
    agent_uid = int(os.getenv("AGORA_AGENT_UID", "0"))

    user_token = _rtc_token(app_id, app_cert, channel, user_uid)
    agent_token = _rtc_token(app_id, app_cert, channel, agent_uid)
    asr_language = os.getenv("AGORA_ASR_LANGUAGE", "multi")

    llm = _build_llm_block(req.provider)
    properties: dict[str, Any] = {
        "channel": channel,
        "token": agent_token,
        "agent_rtc_uid": str(agent_uid),
        "remote_rtc_uids": [str(user_uid)],
        "enable_string_uid": False,
        "idle_timeout": int(os.getenv("AGORA_IDLE_TIMEOUT", "180")),
        "asr": {
            "credential_mode": "managed",
            "vendor": os.getenv("AGORA_ASR_VENDOR", "deepgram"),
            "params": {
                "url": "wss://api.deepgram.com/v1/listen",
                "model": os.getenv("AGORA_ASR_MODEL", "nova-3"),
                "language": asr_language,
            },
        },
        "llm": llm,
        "tts": _build_tts_block(),
    }

    payload = {"name": f"labsight-{uuid.uuid4().hex[:12]}", "properties": properties}
    url = f"https://api.agora.io/api/conversational-ai-agent/v2/projects/{app_id}/join"
    try:
        response = requests.post(
            url,
            headers={"Authorization": _basic_auth_header(), "Content-Type": "application/json"},
            json=payload,
            timeout=25,
        )
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Agora Agent 启动请求失败：{exc}") from exc
    if response.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Agora Agent 启动失败 {response.status_code}: {response.text[:1800]}")

    data = response.json()
    llm_vendor = "labsight-gateway" if _custom_llm_url() else llm.get("vendor", "managed")
    return {
        "ok": True,
        "mode": "agora_realtime_voice",
        "app_id": app_id,
        "channel": channel,
        "uid": user_uid,
        "rtc_token": user_token,
        "agent_uid": agent_uid,
        "agent_id": data.get("agent_id"),
        "agent_status": data.get("status", "RUNNING"),
        "asr": {"vendor": properties["asr"]["vendor"], "model": properties["asr"]["params"]["model"], "language": asr_language},
        "tts": {"vendor": properties["tts"]["vendor"], "model": properties["tts"]["params"].get("model")},
        "llm": {"vendor": llm_vendor, "model": llm.get("params", {}).get("model")},
    }


def _stop_session(req: AgoraSessionRequest) -> dict[str, Any]:
    app_id = _env("AGORA_APP_ID")
    if not req.agent_id:
        return {"ok": True, "stopped": False, "reason": "missing_agent_id"}
    url = f"https://api.agora.io/api/conversational-ai-agent/v2/projects/{app_id}/agents/{req.agent_id}/leave"
    try:
        response = requests.post(url, headers={"Authorization": _basic_auth_header()}, timeout=15)
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Agora Agent 停止请求失败：{exc}") from exc
    if response.status_code >= 400 and response.status_code != 404:
        raise HTTPException(status_code=502, detail=f"Agora Agent 停止失败 {response.status_code}: {response.text[:1200]}")
    return {"ok": True, "stopped": True, "agent_id": req.agent_id}


@app.post("/api/agora_session")
def agora_session(req: AgoraSessionRequest):
    action = req.action.strip().lower()
    if action == "start":
        return _start_session(req)
    if action == "stop":
        return _stop_session(req)
    raise HTTPException(status_code=400, detail="action 仅支持 start/stop")
