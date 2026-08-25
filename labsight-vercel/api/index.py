from __future__ import annotations

import os
import time
from typing import Any

import requests
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

app = FastAPI(title="LabSight EVT0 · Vercel", version="0.2.0")

MAX_CONTEXT_CHARS = 50_000
MAX_IMAGE_DATA_URL_CHARS = 3_200_000
MAX_AUDIO_BYTES = 3_500_000


class ProjectContext(BaseModel):
    filename: str = ""
    schematics: list[str] = Field(default_factory=list)
    pcbs: list[str] = Field(default_factory=list)
    project_files: list[str] = Field(default_factory=list)
    references: list[str] = Field(default_factory=list)
    values: list[str] = Field(default_factory=list)
    nets: list[str] = Field(default_factory=list)
    raw_context: str = ""


class AnalyzeRequest(BaseModel):
    question: str = "请分析当前画面并给出下一步调试建议。"
    scene: str = "pcb"
    image_data_url: str
    project_context: ProjectContext | None = None
    conversation: list[dict[str, str]] = Field(default_factory=list)


def _project_context_text(project: ProjectContext | None) -> str:
    if not project:
        return "当前没有上传 KiCad 工程；请仅基于画面做观察，并明确不确定性。"
    refs = ", ".join(project.references[:150]) or "未提取到"
    vals = ", ".join(project.values[:120]) or "未提取到"
    nets = ", ".join(project.nets[:120]) or "未提取到"
    raw = project.raw_context[:MAX_CONTEXT_CHARS]
    return (
        f"工程文件: {project.filename}\n"
        f"原理图: {', '.join(project.schematics) or '无'}\n"
        f"PCB: {', '.join(project.pcbs) or '无'}\n"
        f"提取到的位号(部分): {refs}\n"
        f"器件值/型号(部分): {vals}\n"
        f"网络名(部分): {nets}\n\n"
        f"工程原始文本节选（可能不完整，仅用于辅助判断）:\n{raw}"
    )


def _scene_instruction(scene: str) -> str:
    if scene == "scope":
        return (
            "当前画面主要是示波器/逻辑分析仪/仪器屏幕。优先读取能可靠辨认的波形与测量值："
            "频率、周期、Vpp、幅度、偏置、占空比、上升/下降时间、触发状态、时基、垂直档位。"
            "如果刻度或数字不够清楚，不要编造数值，指出需要用户把镜头拉近、调整曝光或暂停波形。"
        )
    if scene == "instrument":
        return (
            "当前画面主要是实验室仪器。识别仪器类型、通道状态、显示读数、告警和连接状态，"
            "结合用户问题给出可执行的下一步检查。不要凭模糊字符猜测精确数值。"
        )
    return (
        "当前画面主要是 PCB/硬件实物。优先识别板卡、接口、芯片丝印、位号、焊接异常、探头位置，"
        "并尝试把实物与 KiCad 工程中的位号/网络对应起来。任何无法从画面或工程确认的内容都要标为不确定。"
    )


def _demo_answer(req: AnalyzeRequest) -> str:
    scene_name = {"pcb": "PCB", "scope": "示波器", "instrument": "仪器"}.get(req.scene, "画面")
    project = "已载入 KiCad 工程上下文" if req.project_context else "尚未载入 KiCad 工程"
    return (
        "**Demo 模式（Vercel 尚未配置 OPENAI_API_KEY）**\n\n"
        f"我已经收到当前{scene_name}截图，{project}。\n\n"
        f"你的问题是：**{req.question}**\n\n"
        "摄像头、浏览器端 KiCad 解析、截图和语音录制链路可以先测试。配置 API Key 后会返回真实视觉分析。\n\n"
        "建议：让目标占画面 70% 以上、锁定焦点和曝光；示波器模式请让时基、V/div、通道和测量栏同时可见。"
    )


def _call_openai_vision(req: AnalyzeRequest) -> str:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        return _demo_answer(req)

    model = os.getenv("OPENAI_VISION_MODEL", "gpt-5.6-luna")
    history = "\n".join(
        f"{m.get('role', 'user')}: {m.get('content', '')[:1000]}" for m in req.conversation[-8:]
    )
    context = _project_context_text(req.project_context)
    user_text = f"""
用户问题：{req.question}

场景要求：{_scene_instruction(req.scene)}

KiCad 工程上下文：
{context}

最近对话：
{history or '无'}

请按下面结构回答：
- 画面观察：只写能看见/确认的事实
- 参数/器件识别：列出可确认的器件、位号、网络或波形参数；不确定的标注“不确定”
- 判断：结合 KiCad 工程推断可能原因，区分“事实”和“推断”
- 下一步操作：给用户 1~4 个具体动作，一次不要让用户做太多
- 需要我继续观察：明确告诉用户下一步应把镜头、探头或仪器显示到哪里

如果用户询问示波器上的数值，必须从当前截图读取；看不清就明确说看不清，不要猜。
回答用中文，工程上可执行。
""".strip()

    payload = {
        "model": model,
        "instructions": (
            "你是 LabSight，一个电子硬件调试视觉助手。你可以看到实验室摄像头当前帧，"
            "并获得用户在浏览器中解析出的 KiCad 工程节选。首要目标是避免幻觉："
            "图像看不到或工程没有的信息不要声称已确认。指导用户操作测试设备时，以低风险、可逆、逐步验证为原则。"
        ),
        "input": [
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": user_text},
                    {"type": "input_image", "image_url": req.image_data_url, "detail": "high"},
                ],
            }
        ],
        "max_output_tokens": 1400,
    }

    try:
        r = requests.post(
            "https://api.openai.com/v1/responses",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=payload,
            timeout=90,
        )
        if r.status_code >= 400:
            raise HTTPException(status_code=502, detail=f"OpenAI API error {r.status_code}: {r.text[:1200]}")
        data = r.json()
        texts: list[str] = []
        for item in data.get("output", []):
            if item.get("type") == "message":
                for c in item.get("content", []):
                    if c.get("type") == "output_text" and c.get("text"):
                        texts.append(c["text"])
        return "\n".join(texts).strip() or "模型没有返回可显示文本。"
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"模型请求失败: {exc}") from exc


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "ai": bool(os.getenv("OPENAI_API_KEY")),
        "vision_model": os.getenv("OPENAI_VISION_MODEL", "gpt-5.6-luna"),
        "deployment": "vercel-stateless",
        "time": int(time.time()),
    }


@app.post("/api/analyze")
def analyze(req: AnalyzeRequest):
    if not req.image_data_url.startswith("data:image/"):
        raise HTTPException(status_code=400, detail="image_data_url 必须是浏览器截图 data URL")
    if len(req.image_data_url) > MAX_IMAGE_DATA_URL_CHARS:
        raise HTTPException(status_code=413, detail="截图过大。请缩小 AI 分析帧或降低 JPEG 质量。")
    answer = _call_openai_vision(req)
    return {"answer": answer, "demo": not bool(os.getenv("OPENAI_API_KEY"))}


@app.post("/api/transcribe")
async def transcribe(file: UploadFile = File(...)):
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="未配置 OPENAI_API_KEY，无法进行语音转写")
    blob = await file.read()
    if not blob:
        raise HTTPException(status_code=400, detail="音频为空")
    if len(blob) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="录音过长，请控制在约 30 秒内。")
    model = os.getenv("OPENAI_TRANSCRIBE_MODEL", "gpt-4o-mini-transcribe")
    try:
        r = requests.post(
            "https://api.openai.com/v1/audio/transcriptions",
            headers={"Authorization": f"Bearer {api_key}"},
            files={"file": (file.filename or "question.webm", blob, file.content_type or "audio/webm")},
            data={"model": model},
            timeout=60,
        )
        if r.status_code >= 400:
            raise HTTPException(status_code=502, detail=f"语音转写失败 {r.status_code}: {r.text[:800]}")
        return {"text": r.json().get("text", "").strip()}
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"语音转写请求失败: {exc}") from exc


@app.post("/api/speech")
def speech(payload: dict[str, Any]):
    text = str(payload.get("text", "")).strip()
    if not text:
        raise HTTPException(status_code=400, detail="缺少 text")
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="未配置 OPENAI_API_KEY")
    model = os.getenv("OPENAI_TTS_MODEL", "gpt-4o-mini-tts")
    voice = os.getenv("OPENAI_TTS_VOICE", "marin")
    try:
        r = requests.post(
            "https://api.openai.com/v1/audio/speech",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={"model": model, "voice": voice, "input": text[:2600], "response_format": "mp3"},
            timeout=60,
        )
        if r.status_code >= 400:
            raise HTTPException(status_code=502, detail=f"TTS 失败 {r.status_code}: {r.text[:800]}")
        return Response(content=r.content, media_type="audio/mpeg")
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"TTS 请求失败: {exc}") from exc
