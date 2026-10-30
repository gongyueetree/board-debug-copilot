from __future__ import annotations

import os
import re
from typing import Any, Literal
from datetime import datetime

import requests
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field

from api._security import rate_limit, require_session

app = FastAPI(title="LabSight Analyze", version="0.6.0")

MAX_CONTEXT_CHARS = 50_000
MAX_IMAGE_DATA_URL_CHARS = 3_200_000

SYSTEM_PROMPT = (
    "你是 LabSight，一个电子硬件调试视觉助手。你可以看到实验室摄像头当前帧，"
    "并获得用户在浏览器中解析出的 KiCad 工程节选。首要目标是准确回答用户刚刚提出的具体问题。"
    "用户问题的优先级高于场景默认分析模板：如果用户问品牌、厂商、型号、某个按钮/接口/读数，就直接回答那个问题，"
    "不要擅自改成通用的示波器参数分析或 PCB 全板分析。"
    "只有当用户问题本身是泛化的‘分析当前画面/信号/仪器’时，才使用场景默认分析结构。"
    "无法确认的信息要明确标注不确定，不要编造。回答用中文。"
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


class CameraFrame(BaseModel):
    role: Literal["pcb", "instrument"]
    captured_at: datetime | None = None
    image_data_url: str = Field(max_length=MAX_IMAGE_DATA_URL_CHARS)


class AnalyzeRequest(BaseModel):
    question: str = "请分析当前画面并给出下一步调试建议。"
    scene: str = "pcb"
    provider: str = "openai"
    image_data_url: str = Field(max_length=MAX_IMAGE_DATA_URL_CHARS)
    camera_frames: list[CameraFrame] = Field(default_factory=list, max_length=2)
    project_context: ProjectContext | None = None
    conversation: list[dict[str, str]] = Field(default_factory=list)


def _split_data_url(data_url: str) -> tuple[str, str]:
    m = re.match(r"^data:([^;]+);base64,(.+)$", data_url, re.DOTALL)
    if not m:
        raise HTTPException(status_code=400, detail="无效的 data URL")
    return m.group(1), m.group(2)


def _image_items(req: AnalyzeRequest) -> list[tuple[str, str]]:
    if req.camera_frames:
        roles = [frame.role for frame in req.camera_frames]
        if len(set(roles)) != len(roles):
            raise HTTPException(status_code=400, detail="每个摄像头角色只能提交一张图")
        items = [(f"来源：{'PCB 摄像头' if f.role == 'pcb' else '仪器摄像头'}；浏览器截图时间：{f.captured_at.isoformat() if f.captured_at else '未提供'}", f.image_data_url) for f in req.camera_frames]
    else:
        items = [("来源：当前摄像头", req.image_data_url)]
    if sum(len(data) for _, data in items) > MAX_IMAGE_DATA_URL_CHARS:
        raise HTTPException(status_code=413, detail="截图总量过大，请降低 JPEG 质量或缩小分析帧。")
    for _, data in items:
        mime, _ = _split_data_url(data)
        if mime not in {"image/jpeg", "image/png", "image/webp"}:
            raise HTTPException(status_code=400, detail="截图必须为 JPEG、PNG 或 WebP data URL")
    return items


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


def _question_intent(question: str) -> str:
    q = (question or "").strip().lower()
    identity_words = [
        "什么品牌", "哪个品牌", "品牌", "什么牌子", "哪家", "厂商", "厂家", "制造商",
        "什么型号", "哪个型号", "型号", "model", "brand", "manufacturer", "vendor",
    ]
    if any(word in q for word in identity_words):
        return "identity"
    if any(word in q for word in ["频率", "周期", "vpp", "峰峰", "占空比", "偏置", "时基", "垂直档位", "波形", "信号"]):
        return "measurement"
    generic_patterns = ["分析当前", "看一下现在", "现在怎么样", "有什么问题", "下一步", "检查一下"]
    if any(word in q for word in generic_patterns) or not q:
        return "generic"
    return "specific"


def _scene_instruction(scene: str, question: str) -> str:
    intent = _question_intent(question)
    if scene == "dual":
        return ("你收到两张分别标注来源的截图：PCB 和仪器。先回答用户问题，明确区分板上丝印与仪器显示读数，"
                "结合 KiCad 给出可验证的关联与下一步测量。不能仅因同时拍摄就认定仪器探头连接了某个网络或测试点；"
                "两路是浏览器近同时截图，并非硬件同步采样，不得据此计算跨摄像头精确时序。")
    if intent == "identity":
        if scene in {"scope", "instrument"}:
            return (
                "用户当前是在询问仪器身份。优先检查画面中的品牌 Logo、厂商文字、型号铭牌、面板标识和 UI 品牌特征，"
                "直接回答品牌/厂商/型号；如果只能确认品牌不能确认型号，就只说能确认的部分。"
                "不要自动展开频率、Vpp、时基等信号参数，除非用户同时问了这些。"
            )
        return (
            "用户当前是在询问画面对象的品牌/厂商/型号。优先读取可见 Logo、丝印、型号或铭牌，直接回答身份信息。"
        )
    if scene == "scope":
        if intent == "specific":
            return (
                "这是示波器场景，但必须先直接回答用户的具体问题。只读取与该问题有关的画面证据；"
                "不要因为场景是示波器就强制输出完整的频率/Vpp/时基分析。"
            )
        return (
            "这是示波器测量场景。第一优先级是从屏幕直接读取当前信号的基本参数："
            "频率/周期、Vpp、最大值/最小值、平均值或直流偏置、占空比（能确认多少写多少），"
            "以及判断这些数值所必需的时基、垂直档位、探头倍率和耦合方式。"
            "随后判断波形形状和异常，例如过冲、振铃、噪声、纹波、削顶、占空比异常、触发不稳。"
        )
    if scene == "instrument":
        if intent == "specific":
            return "这是通用仪器场景。先直接回答用户的具体问题，只读取与问题相关的画面证据。"
        return (
            "这是通用仪器测量场景。第一优先级是读取当前真正的测量结果/显示读数、单位、通道和量程/档位，"
            "然后说明状态、告警或异常，再给出与用户问题直接相关的判断和下一步。"
        )
    if intent == "specific":
        return "这是 PCB/硬件实物。先直接回答用户的具体问题，只引用画面或 KiCad 中与问题直接相关的证据。"
    return (
        "这是 PCB/硬件实物。先逐字读取明显可见的板名、丝印、接口标签、芯片顶标/型号、位号、频率标记和测试点，"
        "再分析板卡功能。不要用泛泛的‘一个芯片/一些器件’替代可读信息。"
    )


def _answer_structure(scene: str, question: str) -> str:
    intent = _question_intent(question)
    if intent == "identity":
        return (
            "回答格式：先用一句话直接给出能确认的品牌/厂商/型号；随后最多用 1~3 个简短证据说明你从画面哪里看出来。"
            "如果无法可靠确认，就明确说‘当前画面无法确认’，并指出需要拍清楚哪个 Logo/铭牌区域。不要输出通用信号分析。"
        )
    if intent == "specific":
        return "直接回答用户问题。结论优先，必要时给 1~3 条证据或下一步；不要套用固定章节，也不要回答没问的内容。"
    if scene == "dual":
        return "先回答当前问题，再分别列出 PCB 可见证据、仪器读数与单位、可确认的关联及下一步测量。缺少探头接线信息时明确询问，不推断未见连接。"
    if scene == "scope":
        return (
            "请按以下结构，直接给测量结论：\n"
            "1. 当前信号基本参数\n"
            "2. 波形状态 / 异常\n"
            "3. 与当前问题相关的判断\n"
            "4. 下一步操作（1~3步）"
        )
    if scene == "instrument":
        return (
            "请按以下结构：\n1. 当前测量结果\n2. 当前状态 / 异常\n3. 与当前问题相关的判断\n4. 下一步操作（1~3步）"
        )
    return (
        "请完整回答。按以下结构：\n1. 画面观察\n2. 可读丝印 / 器件 / 参数\n3. 功能或故障判断\n4. 下一步操作（1~4步）"
    )


def _user_text(req: AnalyzeRequest) -> str:
    history = "\n".join(
        f"{m.get('role', 'user')}: {m.get('content', '')[:1000]}" for m in req.conversation[-8:]
    )
    scene = "dual" if len(req.camera_frames) == 2 else "instrument" if req.camera_frames and req.camera_frames[0].role == "instrument" else req.scene
    return f"""
用户刚刚的问题（最高优先级）：{req.question}

场景辅助要求：{_scene_instruction(scene, req.question)}

KiCad 工程上下文：
{_project_text(req.project_context)}

最近对话：
{history or '无'}

回答要求：{_answer_structure(scene, req.question)}
""".strip()


def _call_gemini(req: AnalyzeRequest) -> tuple[str, str, str | None]:
    key = os.getenv("GEMINI_API_KEY")
    if not key:
        raise HTTPException(status_code=503, detail="未配置 GEMINI_API_KEY")
    model = os.getenv("GEMINI_VISION_MODEL", "gemini-2.5-flash")
    parts = [{"text": _user_text(req)}]
    for label, data_url in _image_items(req):
        mime, b64 = _split_data_url(data_url)
        parts.extend([{"text": label}, {"inlineData": {"mimeType": mime, "data": b64}}])
    payload = {
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {"maxOutputTokens": 4096, "temperature": 0.15, "thinkingConfig": {"thinkingBudget": 0}},
    }
    try:
        r = requests.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            headers={"x-goog-api-key": key, "Content-Type": "application/json"}, json=payload, timeout=90,
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
        return answer, model, finish_reason
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Gemini 请求失败: {exc}") from exc


def _call_openai(req: AnalyzeRequest) -> tuple[str, str, str | None]:
    key = os.getenv("OPENAI_API_KEY")
    if not key:
        raise HTTPException(status_code=503, detail="未配置 OPENAI_API_KEY")
    model = os.getenv("OPENAI_VISION_MODEL", "gpt-5.6-luna")
    content = [{"type": "input_text", "text": _user_text(req)}]
    for label, data_url in _image_items(req):
        content.extend([{"type": "input_text", "text": label}, {"type": "input_image", "image_url": data_url, "detail": "high"}])
    payload = {
        "model": model,
        "instructions": SYSTEM_PROMPT,
        "input": [{"role": "user", "content": content}],
        "max_output_tokens": 4096,
    }
    try:
        r = requests.post(
            "https://api.openai.com/v1/responses",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"}, json=payload, timeout=90,
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
def analyze(req: AnalyzeRequest, request: Request):
    require_session(request)
    rate_limit(request, "analyze", limit=90, window=300.0)
    _image_items(req)

    provider = req.provider.lower().strip()
    if provider == "gemini":
        answer, model, finish_reason = _call_gemini(req)
    elif provider == "openai":
        answer, model, finish_reason = _call_openai(req)
    else:
        raise HTTPException(status_code=400, detail="provider 仅支持 openai 或 gemini")

    return {"answer": answer, "provider": provider, "model": model, "finish_reason": finish_reason, "demo": False, "camera_roles": [f.role for f in req.camera_frames]}
