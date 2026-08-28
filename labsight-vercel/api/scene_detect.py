from __future__ import annotations

import json
import os
import re
from typing import Literal

import requests
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="LabSight Scene Detect", version="0.1.0")

Scene = Literal["pcb", "scope", "instrument", "other"]


class SceneRequest(BaseModel):
    provider: str = "gemini"
    image_data_url: str


class SceneResult(BaseModel):
    scene: Scene
    subtype: str = ""
    confidence: float = Field(ge=0, le=1)
    evidence: list[str] = Field(default_factory=list)


def _split_data_url(data_url: str) -> tuple[str, str]:
    m = re.match(r"^data:([^;]+);base64,(.+)$", data_url, re.DOTALL)
    if not m:
        raise HTTPException(status_code=400, detail="无效的 image_data_url")
    return m.group(1), m.group(2)


PROMPT = """
你是 LabSight 的实时场景分类器。只判断当前摄像头主要在看什么，不做详细分析。

scene 只能是：
- pcb: 裸露/装配后的 PCB、电路板、开发板、电子模块为主体
- scope: 示波器或示波器屏幕/波形为主体，只要明显看到示波器波形网格、CH1/CH2、time/div、volt/div 等就优先归为 scope
- instrument: 其它电子测试仪器或其显示界面，例如万用表、电源、频谱仪、逻辑分析仪、信号发生器、电子负载
- other: 上述都不是，或画面不足以判断

subtype 可填写 digital_oscilloscope / power_supply / multimeter / spectrum_analyzer / signal_generator / logic_analyzer / pcb_board / other 等简短英文。
confidence 0~1。evidence 最多 4 条，只写支持分类的可见特征。

严格只返回 JSON：
{"scene":"scope","subtype":"digital_oscilloscope","confidence":0.97,"evidence":["波形网格","CH1","500us/div"]}
""".strip()


def _extract_json(text: str) -> dict:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    try:
        return json.loads(text)
    except Exception:
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if not m:
            raise HTTPException(status_code=502, detail="场景识别返回格式错误")
        return json.loads(m.group(0))


def _gemini(req: SceneRequest) -> tuple[SceneResult, str]:
    key = os.getenv("GEMINI_API_KEY")
    if not key:
        raise HTTPException(status_code=503, detail="未配置 GEMINI_API_KEY")
    model = os.getenv("GEMINI_SCENE_MODEL", os.getenv("GEMINI_VISION_MODEL", "gemini-2.5-flash"))
    mime, b64 = _split_data_url(req.image_data_url)
    payload = {
        "contents": [{"role": "user", "parts": [
            {"text": PROMPT},
            {"inlineData": {"mimeType": mime, "data": b64}},
        ]}],
        "generationConfig": {
            "temperature": 0,
            "maxOutputTokens": 220,
            "responseMimeType": "application/json",
            "thinkingConfig": {"thinkingBudget": 0},
        },
    }
    try:
        r = requests.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            headers={"x-goog-api-key": key, "Content-Type": "application/json"},
            json=payload,
            timeout=25,
        )
        if r.status_code >= 400:
            raise HTTPException(status_code=502, detail=f"Gemini scene error {r.status_code}: {r.text[:500]}")
        parts = r.json().get("candidates", [{}])[0].get("content", {}).get("parts", [])
        text = "".join(p.get("text", "") for p in parts)
        return SceneResult.model_validate(_extract_json(text)), model
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Gemini 场景识别失败: {exc}") from exc


def _openai(req: SceneRequest) -> tuple[SceneResult, str]:
    key = os.getenv("OPENAI_API_KEY")
    if not key:
        raise HTTPException(status_code=503, detail="未配置 OPENAI_API_KEY")
    model = os.getenv("OPENAI_SCENE_MODEL", os.getenv("OPENAI_VISION_MODEL", "gpt-5.6-luna"))
    payload = {
        "model": model,
        "input": [{"role": "user", "content": [
            {"type": "input_text", "text": PROMPT},
            {"type": "input_image", "image_url": req.image_data_url, "detail": "low"},
        ]}],
        "max_output_tokens": 220,
    }
    try:
        r = requests.post(
            "https://api.openai.com/v1/responses",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json=payload,
            timeout=25,
        )
        if r.status_code >= 400:
            raise HTTPException(status_code=502, detail=f"OpenAI scene error {r.status_code}: {r.text[:500]}")
        texts = []
        for item in r.json().get("output", []):
            if item.get("type") == "message":
                for c in item.get("content", []):
                    if c.get("type") == "output_text":
                        texts.append(c.get("text", ""))
        return SceneResult.model_validate(_extract_json("\n".join(texts))), model
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"OpenAI 场景识别失败: {exc}") from exc


@app.post("/api/scene_detect")
def scene_detect(req: SceneRequest):
    if not req.image_data_url.startswith("data:image/"):
        raise HTTPException(status_code=400, detail="image_data_url 必须是图片 data URL")
    if len(req.image_data_url) > 900_000:
        raise HTTPException(status_code=413, detail="场景识别帧过大")

    provider = req.provider.lower().strip()
    result, model = _gemini(req) if provider == "gemini" else _openai(req)
    return {**result.model_dump(), "provider": provider, "model": model}
