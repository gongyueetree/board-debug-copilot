from __future__ import annotations

import json
import os
import re
from typing import Any

import requests
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="LabSight PCB Deep Vision", version="0.5.0")

MAX_TOTAL_IMAGE_CHARS = 3_600_000
MAX_CONTEXT_CHARS = 24_000


class DeepVisionRequest(BaseModel):
    provider: str = "gemini"
    overview_image: str
    tile_images: list[str] = Field(default_factory=list)
    question: str = "请深度识别这块 PCB 的板名、丝印、关键器件型号、接口和功能。"
    project_context: dict[str, Any] | None = None
    source_width: int | None = None
    source_height: int | None = None


def _split_data_url(data_url: str) -> tuple[str, str]:
    m = re.match(r"^data:([^;]+);base64,(.+)$", data_url, re.DOTALL)
    if not m:
        raise HTTPException(status_code=400, detail="无效的图像 data URL")
    return m.group(1), m.group(2)


def _project_text(ctx: dict[str, Any] | None) -> str:
    if not ctx:
        return "没有 KiCad 工程上下文。"
    raw = str(ctx.get("raw_context", ""))[:MAX_CONTEXT_CHARS]
    refs = ", ".join(map(str, ctx.get("references", [])[:120]))
    vals = ", ".join(map(str, ctx.get("values", [])[:120]))
    nets = ", ".join(map(str, ctx.get("nets", [])[:100]))
    return f"位号: {refs or '无'}\n器件值/型号: {vals or '无'}\n网络: {nets or '无'}\n工程节选:\n{raw}"


DEEP_PROMPT = """
你是 LabSight PCB Deep Vision，引擎目标不是泛泛描述，而是尽可能从高清 PCB 照片里提取工程信息。

输入包含：
- IMAGE 0：PCB 整体概览；
- IMAGE 1..N：从原始高清帧裁出的重叠局部区域，专门用于读取丝印、芯片顶标、接口标记和频率标记。

执行优先级：
1. 首先逐字读取所有可见文字。板名、接口、引脚标签、频率、测试点、芯片顶标优先级最高。
2. 对每个主要 IC / 晶振 / 模块，尽量给出实际可见 marking；不要只说“一个芯片”。
3. 字符部分可见时，给出 1~3 个候选值和 confidence，不要因为不能 100% 确定就全部省略。
4. 根据可见丝印、封装、连接和板名推断器件作用，但明确区分 observed 与 inferred。
5. 如果有 KiCad 上下文，把视觉读到的位号/型号与工程内容交叉核对。
6. 不要把明显可读的文字称为“模糊”。只有确实无法辨认时才写 unreadable。
7. 对 PCB 功能给出信号链：电源/控制输入 -> 核心处理 -> 输出，能确认多少写多少。

必须只返回 JSON，不要 Markdown 代码围栏。结构：
{
  "board_identity": {"name":"", "type":"", "confidence":0.0, "evidence":[]},
  "visible_texts": [{"text":"", "kind":"board_title|silkscreen|pin_label|frequency|chip_marking|testpoint|other", "region":"", "confidence":0.0}],
  "components": [{"region":"", "reference":"", "marking":"", "candidates":[], "category":"", "likely_part":"", "role":"", "confidence":0.0, "observed":[], "inferred":[]}],
  "connectors": [{"region":"", "labels":[], "function":"", "confidence":0.0}],
  "signal_chain": [],
  "board_function":"",
  "uncertain_items": [],
  "next_actions": [],
  "summary":""
}

summary 用中文写成适合工程师阅读的精炼结论。confidence 范围 0~1。
""".strip()


def _extract_json(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.I)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        start, end = cleaned.find("{"), cleaned.rfind("}")
        if start >= 0 and end > start:
            try:
                return json.loads(cleaned[start:end + 1])
            except json.JSONDecodeError:
                pass
    return {"summary": cleaned, "raw_model_output": cleaned}


def _gemini(req: DeepVisionRequest) -> tuple[dict[str, Any], str]:
    key = os.getenv("GEMINI_API_KEY")
    if not key:
        raise HTTPException(status_code=503, detail="未配置 GEMINI_API_KEY")
    model = os.getenv("GEMINI_DEEP_VISION_MODEL", os.getenv("GEMINI_VISION_MODEL", "gemini-2.5-flash"))
    parts: list[dict[str, Any]] = [{"text": DEEP_PROMPT + "\n\n用户要求：" + req.question + "\n\nKiCad 上下文：\n" + _project_text(req.project_context)}]
    for i, image in enumerate([req.overview_image, *req.tile_images]):
        mime, b64 = _split_data_url(image)
        parts.append({"text": f"IMAGE {i}"})
        parts.append({"inlineData": {"mimeType": mime, "data": b64}})
    payload = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {"temperature": 0.1, "maxOutputTokens": 5000, "responseMimeType": "application/json"},
    }
    r = requests.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
        headers={"x-goog-api-key": key, "Content-Type": "application/json"},
        json=payload,
        timeout=90,
    )
    if r.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Gemini Deep Vision error {r.status_code}: {r.text[:1600]}")
    data = r.json()
    texts = [p.get("text", "") for c in data.get("candidates", []) for p in c.get("content", {}).get("parts", []) if p.get("text")]
    return _extract_json("\n".join(texts)), model


def _openai(req: DeepVisionRequest) -> tuple[dict[str, Any], str]:
    key = os.getenv("OPENAI_API_KEY")
    if not key:
        raise HTTPException(status_code=503, detail="未配置 OPENAI_API_KEY")
    model = os.getenv("OPENAI_DEEP_VISION_MODEL", os.getenv("OPENAI_VISION_MODEL", "gpt-5.6-luna"))
    content: list[dict[str, Any]] = [{"type": "input_text", "text": DEEP_PROMPT + "\n\n用户要求：" + req.question + "\n\nKiCad 上下文：\n" + _project_text(req.project_context)}]
    for i, image in enumerate([req.overview_image, *req.tile_images]):
        content.append({"type": "input_text", "text": f"IMAGE {i}"})
        content.append({"type": "input_image", "image_url": image, "detail": "high"})
    payload = {"model": model, "input": [{"role": "user", "content": content}], "max_output_tokens": 5000}
    r = requests.post("https://api.openai.com/v1/responses", headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"}, json=payload, timeout=90)
    if r.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"OpenAI Deep Vision error {r.status_code}: {r.text[:1600]}")
    data = r.json()
    texts = [p.get("text", "") for item in data.get("output", []) if item.get("type") == "message" for p in item.get("content", []) if p.get("type") == "output_text" and p.get("text")]
    return _extract_json("\n".join(texts)), model


@app.post("/api/pcb_deep_analyze")
def pcb_deep_analyze(req: DeepVisionRequest):
    images = [req.overview_image, *req.tile_images]
    if not 1 <= len(images) <= 7:
        raise HTTPException(status_code=400, detail="Deep Vision 需要 1~7 张图像")
    total_chars = sum(len(x) for x in images)
    if total_chars > MAX_TOTAL_IMAGE_CHARS:
        raise HTTPException(status_code=413, detail=f"Deep Vision 图像总量过大 ({total_chars} chars)，请降低 tile JPEG 质量")
    provider = req.provider.lower().strip()
    if provider == "gemini":
        result, model = _gemini(req)
    elif provider == "openai":
        result, model = _openai(req)
    else:
        raise HTTPException(status_code=400, detail="provider 仅支持 gemini/openai")
    return {
        "ok": True,
        "mode": "pcb_deep_vision",
        "provider": provider,
        "model": model,
        "source": {"width": req.source_width, "height": req.source_height, "images": len(images), "payload_chars": total_chars},
        "result": result,
    }
