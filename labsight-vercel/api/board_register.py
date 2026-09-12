from __future__ import annotations

import json
import os
import re
from typing import Any, Literal

import requests
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field

from api._security import rate_limit, require_session

app = FastAPI(title="LabSight KiCad Board Registration", version="0.1.0")

MAX_IMAGE_CHARS = 3_200_000
MAX_MAP_CHARS = 1_800_000


class BoardRegistrationRequest(BaseModel):
    provider: str = "gemini"
    board_image: str
    placement_map_image: str
    board_bbox: dict[str, float]
    anchors: list[dict[str, Any]] = Field(default_factory=list)


class Point(BaseModel):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)


class RegistrationResult(BaseModel):
    matched: bool = False
    confidence: float = Field(default=0, ge=0, le=1)
    visible_side: Literal["front", "back", "unknown"] = "unknown"
    image_quad: list[Point] = Field(default_factory=list)
    evidence: list[str] = Field(default_factory=list)


def _split_data_url(data_url: str) -> tuple[str, str]:
    m = re.match(r"^data:([^;]+);base64,(.+)$", data_url, re.DOTALL)
    if not m:
        raise HTTPException(status_code=400, detail="无效的图像 data URL")
    return m.group(1), m.group(2)


def _extract_json(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.I)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    try:
        return json.loads(cleaned)
    except Exception:
        start, end = cleaned.find("{"), cleaned.rfind("}")
        if start >= 0 and end > start:
            try:
                return json.loads(cleaned[start:end + 1])
            except Exception:
                pass
    raise HTTPException(status_code=502, detail="板卡配准模型返回格式错误")


def _prompt(req: BoardRegistrationRequest) -> str:
    anchors = json.dumps(req.anchors[:40], ensure_ascii=False, separators=(",", ":"))
    bbox = json.dumps(req.board_bbox, ensure_ascii=False, separators=(",", ":"))
    return f"""
你是 LabSight PCB 几何配准器。
IMAGE 0 是摄像头拍到的真实 PCB；IMAGE 1 是从当前 KiCad .kicad_pcb 生成的 placement map。
两张图应代表同一块 PCB。你的任务不是识别器件型号，而是把 KiCad 坐标系准确映射到真实照片。

KiCad board_bbox: {bbox}
部分锚点 footprint（用于判断方向，不要求逐个识别）: {anchors}

请先利用板框、安装孔、大型连接器、主 IC、晶振等稳定特征判断两张图是否匹配，再给出 IMAGE 0 中真实 PCB 的四个角。

极其重要：image_quad 的四点必须按 IMAGE 1 / KiCad placement map 的方向对应，而不是按照片视觉上的“左上右上”机械排序：
0 = placement map 左上角 (min_x,min_y) 在真实照片中的位置
1 = placement map 右上角 (max_x,min_y) 在真实照片中的位置
2 = placement map 右下角 (max_x,max_y) 在真实照片中的位置
3 = placement map 左下角 (min_x,max_y) 在真实照片中的位置

坐标全部是相对 IMAGE 0 宽高的 0~1 归一化坐标。即使 PCB 在照片里旋转、倾斜或透视，也必须保持以上 KiCad 方向对应关系。
visible_side: 正面器件面为 front，背面为 back，无法判断为 unknown。
只有能较可靠匹配时 matched=true；看不到完整板框、明显不是同一块板或方向无法判断时 matched=false。
evidence 最多 4 条简短描述。

严格只返回 JSON，例如：
{{
  "matched": true,
  "confidence": 0.94,
  "visible_side": "front",
  "image_quad": [
    {{"x":0.18,"y":0.16}},
    {{"x":0.81,"y":0.20}},
    {{"x":0.79,"y":0.82}},
    {{"x":0.16,"y":0.78}}
  ],
  "evidence": ["四个安装孔一致","USB 接口位置一致"]
}}
""".strip()


def _gemini(req: BoardRegistrationRequest) -> tuple[RegistrationResult, str]:
    key = os.getenv("GEMINI_API_KEY", "").strip()
    if not key:
        raise HTTPException(status_code=503, detail="未配置 GEMINI_API_KEY")
    model = os.getenv("GEMINI_REGISTRATION_MODEL", os.getenv("GEMINI_VISION_MODEL", "gemini-2.5-flash"))
    mime0, b640 = _split_data_url(req.board_image)
    mime1, b641 = _split_data_url(req.placement_map_image)
    payload = {
        "contents": [{"role": "user", "parts": [
            {"text": _prompt(req)},
            {"text": "IMAGE 0：真实 PCB 摄像头画面"},
            {"inlineData": {"mimeType": mime0, "data": b640}},
            {"text": "IMAGE 1：KiCad placement map"},
            {"inlineData": {"mimeType": mime1, "data": b641}},
        ]}],
        "generationConfig": {
            "temperature": 0,
            "maxOutputTokens": 550,
            "responseMimeType": "application/json",
            "thinkingConfig": {"thinkingBudget": 0},
        },
    }
    try:
        r = requests.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            headers={"x-goog-api-key": key, "Content-Type": "application/json"},
            json=payload,
            timeout=45,
        )
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Gemini 板卡配准失败：{exc}") from exc
    if r.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Gemini registration error {r.status_code}: {r.text[:1000]}")
    texts = [p.get("text", "") for c in r.json().get("candidates", []) for p in c.get("content", {}).get("parts", []) if p.get("text")]
    return RegistrationResult.model_validate(_extract_json("\n".join(texts))), model


def _openai(req: BoardRegistrationRequest) -> tuple[RegistrationResult, str]:
    key = os.getenv("OPENAI_API_KEY", "").strip()
    if not key:
        raise HTTPException(status_code=503, detail="未配置 OPENAI_API_KEY")
    model = os.getenv("OPENAI_REGISTRATION_MODEL", os.getenv("OPENAI_VISION_MODEL", "gpt-5.6-luna"))
    payload = {
        "model": model,
        "instructions": "只做 PCB 几何配准。严格返回 JSON。",
        "input": [{"role": "user", "content": [
            {"type": "input_text", "text": _prompt(req)},
            {"type": "input_image", "image_url": req.board_image, "detail": "high"},
            {"type": "input_image", "image_url": req.placement_map_image, "detail": "high"},
        ]}],
        "max_output_tokens": 550,
    }
    try:
        r = requests.post(
            "https://api.openai.com/v1/responses",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json=payload,
            timeout=45,
        )
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"OpenAI 板卡配准失败：{exc}") from exc
    if r.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"OpenAI registration error {r.status_code}: {r.text[:1000]}")
    texts = [
        p.get("text", "")
        for item in r.json().get("output", []) if item.get("type") == "message"
        for p in item.get("content", []) if p.get("type") == "output_text" and p.get("text")
    ]
    return RegistrationResult.model_validate(_extract_json("\n".join(texts))), model


@app.post("/api/board_register")
def board_register(req: BoardRegistrationRequest, request: Request):
    require_session(request)
    rate_limit(request, "board-register", limit=12, window=300.0)
    if len(req.board_image) > MAX_IMAGE_CHARS or len(req.placement_map_image) > MAX_MAP_CHARS:
        raise HTTPException(status_code=413, detail="配准图像过大")
    if not req.board_bbox:
        raise HTTPException(status_code=400, detail="缺少 KiCad board_bbox")

    provider = req.provider.lower().strip()
    if provider == "gemini":
        result, model = _gemini(req)
    elif provider == "openai":
        result, model = _openai(req)
    else:
        raise HTTPException(status_code=400, detail="provider 仅支持 gemini/openai")

    if result.matched and len(result.image_quad) != 4:
        raise HTTPException(status_code=502, detail="配准模型未返回 4 个对应角点")

    return {
        "ok": True,
        "mode": "board_registration",
        "provider": provider,
        "model": model,
        "result": result.model_dump(),
    }
