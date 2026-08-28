from __future__ import annotations

import os
import re
from typing import Any

import requests
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="LabSight Analyze", version="0.5.2")

MAX_CONTEXT_CHARS = 50_000
MAX_IMAGE_DATA_URL_CHARS = 3_200_000

SYSTEM_PROMPT = (
    "你是 LabSight，一个电子硬件调试视觉助手。你可以看到实验室摄像头当前帧，"
    "并获得用户在浏览器中解析出的 KiCad 工程节选。首要目标是准确、具体、可执行。"
    "优先读取画面里与当前调试任务直接相关的信息；无法确认的信息要明确标注不确定，不要编造。"
    "在示波器/仪器场景中，先回答当前测量结果和信号状态，不要花篇幅介绍仪器品牌历史、功能、带宽、采样率等产品参数，"
    "除非这些信息直接影响当前测量判断。回答用中文。"
)


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
    provider: str = "openai"
    image_data_url: str
    project_context: ProjectContext | None = None
    conversation: list[dict[str, str]] = Field(default_factory=list)


def _split_data_url(data_url: str) -> tuple[str, str]:
    m = re.match(r"^data:([^;]+);base64,(.+)$", data_url, re.DOTALL)
    if not m:
        raise HTTPException(status_code=400, detail="无效的 data URL")
    return m.group(1), m.group(2)


def _project_text(project: ProjectContext | None) -> str:
    if not project:
        return "当前没有 KiCad 工程上下文。"
    refs = ", ".join(project.references[:150]) or "未提取到"
    vals = ", ".join(project.values[:120]) or "未提取到"
    nets = ", ".join(project.nets[:120]) or "未提取到"
    raw = project.raw_context[:MAX_CONTEXT_CHARS]
    return (
        f"工程文件: {project.filename}\n"
        f"位号: {refs}\n器件值/型号: {vals}\n网络: {nets}\n\n"
        f"工程节选:\n{raw}"
    )


def _scene_instruction(scene: str) -> str:
    if scene == "scope":
        return (
            "这是示波器测量场景。第一优先级是从屏幕直接读取当前信号的基本参数："
            "频率/周期、Vpp、最大值/最小值、平均值或直流偏置、占空比（能确认多少写多少），"
            "以及判断这些数值所必需的时基、垂直档位、探头倍率和耦合方式。"
            "随后判断波形形状和异常，例如过冲、振铃、噪声、纹波、削顶、占空比异常、触发不稳。"
            "不要单独列‘可读丝印/器件/参数’，不要介绍示波器型号的带宽、采样率、功能等产品规格，"
            "除非它直接限制了当前测量。"
        )
    if scene == "instrument":
        return (
            "这是通用仪器测量场景。第一优先级是读取当前真正的测量结果/显示读数、单位、通道和量程/档位，"
            "然后说明状态、告警或异常，再给出与用户问题直接相关的判断和下一步。"
            "不要单独列‘可读丝印/器件/参数’，不要详细介绍仪器品牌、型号、功能或规格。"
        )
    return (
        "这是 PCB/硬件实物。先逐字读取明显可见的板名、丝印、接口标签、芯片顶标/型号、位号、频率标记和测试点，"
        "再分析板卡功能。不要用泛泛的‘一个芯片/一些器件’替代可读信息。"
    )


def _answer_structure(scene: str) -> str:
    if scene == "scope":
        return (
            "请按以下结构，直接给测量结论，不介绍仪器本身：\n"
            "1. 当前信号基本参数\n"
            "   - 只列能从画面确认的频率/周期、Vpp、最大/最小值、偏置/平均值、占空比等；无法确认的不要猜。\n"
            "   - 时基、垂直档位、探头倍率、耦合方式只作为解释测量值所需的辅助信息，简短列出。\n"
            "2. 波形状态 / 异常\n"
            "   - 直接说明波形类型和可见异常；没有明显异常就明确写‘未见明显异常’。\n"
            "3. 与当前问题相关的判断\n"
            "4. 下一步操作（1~3步）\n"
            "不要输出‘可读丝印 / 器件 / 参数’章节，也不要介绍示波器带宽、采样率、功能菜单。"
        )
    if scene == "instrument":
        return (
            "请按以下结构，直接给测量结论，不介绍仪器本身：\n"
            "1. 当前测量结果\n"
            "   - 只列当前读数、单位、通道、量程/档位等与读数直接有关的信息。\n"
            "2. 当前状态 / 异常\n"
            "3. 与当前问题相关的判断\n"
            "4. 下一步操作（1~3步）\n"
            "不要输出‘可读丝印 / 器件 / 参数’章节，也不要详细介绍仪器品牌、型号、功能或产品规格。"
        )
    return (
        "请完整回答，不要半句结束。按以下结构：\n"
        "1. 画面观察\n"
        "2. 可读丝印 / 器件 / 参数\n"
        "3. 功能或故障判断\n"
        "4. 下一步操作（1~4步）\n"
        "5. 需要我继续观察的位置"
    )


def _user_text(req: AnalyzeRequest) -> str:
    history = "\n".join(
        f"{m.get('role', 'user')}: {m.get('content', '')[:1000]}" for m in req.conversation[-8:]
    )
    return f"""
用户问题：{req.question}

场景要求：{_scene_instruction(req.scene)}

KiCad 工程上下文：
{_project_text(req.project_context)}

最近对话：
{history or '无'}

{_answer_structure(req.scene)}
""".strip()


def _call_gemini(req: AnalyzeRequest) -> tuple[str, str, str | None]:
    key = os.getenv("GEMINI_API_KEY")
    if not key:
        raise HTTPException(status_code=503, detail="未配置 GEMINI_API_KEY")
    model = os.getenv("GEMINI_VISION_MODEL", "gemini-2.5-flash")
    mime, b64 = _split_data_url(req.image_data_url)
    payload = {
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "contents": [{"role": "user", "parts": [
            {"text": _user_text(req)},
            {"inlineData": {"mimeType": mime, "data": b64}},
        ]}],
        "generationConfig": {
            "maxOutputTokens": 4096,
            "temperature": 0.15,
            "thinkingConfig": {"thinkingBudget": 0},
        },
    }
    try:
        r = requests.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            headers={"x-goog-api-key": key, "Content-Type": "application/json"},
            json=payload,
            timeout=90,
        )
        if r.status_code >= 400:
            raise HTTPException(status_code=502, detail=f"Gemini API error {r.status_code}: {r.text[:1400]}")
        data = r.json()
        texts: list[str] = []
        finish_reason = None
        for cand in data.get("candidates", []):
            finish_reason = cand.get("finishReason") or finish_reason
            for part in cand.get("content", {}).get("parts", []):
                if part.get("text"):
                    texts.append(part["text"])
        answer = "\n".join(texts).strip() or "Gemini 没有返回可显示文本。"
        if finish_reason == "MAX_TOKENS":
            answer += "\n\n⚠️ 本次回答达到模型输出上限，建议缩小问题范围或使用 PCB Deep Vision。"
        return answer, model, finish_reason
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Gemini 请求失败: {exc}") from exc


def _call_openai(req: AnalyzeRequest) -> tuple[str, str, str | None]:
    key = os.getenv("OPENAI_API_KEY")
    if not key:
        raise HTTPException(status_code=503, detail="未配置 OPENAI_API_KEY")
    model = os.getenv("OPENAI_VISION_MODEL", "gpt-5.6-luna")
    payload = {
        "model": model,
        "instructions": SYSTEM_PROMPT,
        "input": [{"role": "user", "content": [
            {"type": "input_text", "text": _user_text(req)},
            {"type": "input_image", "image_url": req.image_data_url, "detail": "high"},
        ]}],
        "max_output_tokens": 4096,
    }
    try:
        r = requests.post(
            "https://api.openai.com/v1/responses",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json=payload,
            timeout=90,
        )
        if r.status_code >= 400:
            raise HTTPException(status_code=502, detail=f"OpenAI API error {r.status_code}: {r.text[:1400]}")
        data = r.json()
        texts: list[str] = []
        for item in data.get("output", []):
            if item.get("type") == "message":
                for c in item.get("content", []):
                    if c.get("type") == "output_text" and c.get("text"):
                        texts.append(c["text"])
        return "\n".join(texts).strip() or "模型没有返回可显示文本。", model, data.get("status")
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"OpenAI 请求失败: {exc}") from exc


@app.post("/api/analyze")
def analyze(req: AnalyzeRequest):
    if not req.image_data_url.startswith("data:image/"):
        raise HTTPException(status_code=400, detail="image_data_url 必须是浏览器截图 data URL")
    if len(req.image_data_url) > MAX_IMAGE_DATA_URL_CHARS:
        raise HTTPException(status_code=413, detail="截图过大，请降低 JPEG 质量或缩小分析帧。")

    provider = req.provider.lower().strip()
    if provider == "gemini":
        answer, model, finish_reason = _call_gemini(req)
    elif provider == "openai":
        answer, model, finish_reason = _call_openai(req)
    else:
        raise HTTPException(status_code=400, detail="provider 仅支持 openai 或 gemini")

    return {
        "answer": answer,
        "provider": provider,
        "model": model,
        "finish_reason": finish_reason,
        "demo": False,
    }
