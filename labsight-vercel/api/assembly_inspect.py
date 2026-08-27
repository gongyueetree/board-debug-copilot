from __future__ import annotations

import json
import os
import re
from typing import Any

import requests
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="LabSight PCB Assembly Inspect", version="0.8.3")

MAX_IMAGE_CHARS = 3_200_000
MAX_MAP_CHARS = 1_800_000
MAX_FOOTPRINTS = 180


class AssemblyInspectRequest(BaseModel):
    provider: str = "gemini"
    board_image: str
    placement_map_image: str
    footprints: list[dict[str, Any]] = Field(default_factory=list)
    board_bbox: dict[str, float] | None = None
    question: str = "检查哪些器件没有焊接。"


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
    except json.JSONDecodeError:
        start, end = cleaned.find("{"), cleaned.rfind("}")
        if start >= 0 and end > start:
            candidate = cleaned[start:end + 1]
            try:
                return json.loads(candidate)
            except json.JSONDecodeError:
                pass
    return {"summary": "无法可靠解析装配检查结果。", "missing": [], "uncertain": [], "parse_error": True}


def _compact_footprints(req: AssemblyInspectRequest) -> str:
    rows = []
    for fp in req.footprints[:MAX_FOOTPRINTS]:
        rows.append({
            "ref": fp.get("reference", ""),
            "value": fp.get("value", ""),
            "package": fp.get("package", ""),
            "layer": fp.get("layer", ""),
            "x": fp.get("x"),
            "y": fp.get("y"),
            "rotation": fp.get("rotation", 0),
            "excluded": bool(fp.get("excluded")),
            "pads": [
                {"n": p.get("number", ""), "x": p.get("x"), "y": p.get("y")}
                for p in (fp.get("pads") or [])[:32]
            ],
        })
    return json.dumps(rows, ensure_ascii=False, separators=(",", ":"))


PROMPT = """
你是 PCB 装配检查助手。IMAGE 0 是真实 PCB 照片；IMAGE 1 是从 KiCad PCB 文件生成的“预期器件/焊盘位置图”。
同时提供 KiCad 中每个 footprint 的位号、型号/值、封装、坐标、旋转角度，以及该 footprint 内全部 pad 的分组坐标。

目标只有一个：判断哪些“应该装配的器件”在真实照片中没有焊接。

必须遵守：
1. KiCad footprint 是判断器件归属的唯一依据：同一个 footprint 内的 pads 属于同一个器件。不要把相邻焊盘误拆成多个器件。
2. 先用板框、孔位、主要 IC、接口等特征把真实板照片与 placement map 对齐，再按 footprint 逐个比对。
3. excluded=true、安装孔、测试点等不属于待装配器件，忽略。
4. 对 SMD：应看到器件本体跨在该 footprint 的焊盘组上；仅有焊盘/焊锡而没有器件本体，应判为“未焊接”。
5. 对通孔连接器/SMA/排针：若只看到孔/焊盘而没有连接器本体，应判为“未焊接”。
6. 只有照片足够清楚时才列为 missing；看不清、被遮挡、反光严重的放到 uncertain。
7. 不要输出板卡介绍、器件功能、丝印识别、原理分析、下一步调试建议；不要重复用户问题。
8. 结果要非常短。只输出未焊接和无法确认的具体位号。

只返回 JSON：
{
  "missing": [
    {"reference":"J2", "value":"SYN", "reason":"该 footprint 的整组通孔焊盘可见，但未看到 SMA 连接器本体", "confidence":0.98}
  ],
  "uncertain": [
    {"reference":"R8", "value":"4.7k", "reason":"该位置被反光遮挡", "confidence":0.45}
  ],
  "summary":"确认未焊接：J2、J4。"
}

如果没有确认未焊接器件，missing 返回空数组，summary 写“未发现可确认的漏装器件。”
除位号、型号、封装名外，其余说明使用简体中文。
""".strip()


def _gemini(req: AssemblyInspectRequest) -> tuple[dict[str, Any], str]:
    key = os.getenv("GEMINI_API_KEY")
    if not key:
        raise HTTPException(status_code=503, detail="未配置 GEMINI_API_KEY")
    model = os.getenv("GEMINI_ASSEMBLY_MODEL", os.getenv("GEMINI_VISION_MODEL", "gemini-2.5-flash"))
    mime0, b640 = _split_data_url(req.board_image)
    mime1, b641 = _split_data_url(req.placement_map_image)
    text = PROMPT + "\n\n用户要求：" + req.question + "\n\nKiCad footprint 数据：\n" + _compact_footprints(req)
    payload = {
        "contents": [{"role": "user", "parts": [
            {"text": text},
            {"text": "IMAGE 0：真实 PCB 照片"},
            {"inlineData": {"mimeType": mime0, "data": b640}},
            {"text": "IMAGE 1：KiCad 预期器件/焊盘位置图"},
            {"inlineData": {"mimeType": mime1, "data": b641}},
        ]}],
        "generationConfig": {
            "temperature": 0.02,
            "maxOutputTokens": 1200,
            "responseMimeType": "application/json",
            "thinkingConfig": {"thinkingBudget": 0},
        },
    }
    r = requests.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
        headers={"x-goog-api-key": key, "Content-Type": "application/json"},
        json=payload,
        timeout=90,
    )
    if r.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Gemini Assembly Inspect error {r.status_code}: {r.text[:1200]}")
    data = r.json()
    texts = [p.get("text", "") for c in data.get("candidates", []) for p in c.get("content", {}).get("parts", []) if p.get("text")]
    return _extract_json("\n".join(texts)), model


def _openai(req: AssemblyInspectRequest) -> tuple[dict[str, Any], str]:
    key = os.getenv("OPENAI_API_KEY")
    if not key:
        raise HTTPException(status_code=503, detail="未配置 OPENAI_API_KEY")
    model = os.getenv("OPENAI_ASSEMBLY_MODEL", os.getenv("OPENAI_VISION_MODEL", "gpt-5.6-luna"))
    text = PROMPT + "\n\n用户要求：" + req.question + "\n\nKiCad footprint 数据：\n" + _compact_footprints(req)
    payload = {
        "model": model,
        "instructions": "只做 PCB 装配缺件检查，严格输出简洁 JSON。",
        "input": [{"role": "user", "content": [
            {"type": "input_text", "text": text},
            {"type": "input_image", "image_url": req.board_image, "detail": "high"},
            {"type": "input_image", "image_url": req.placement_map_image, "detail": "high"},
        ]}],
        "max_output_tokens": 1200,
    }
    r = requests.post(
        "https://api.openai.com/v1/responses",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json=payload,
        timeout=90,
    )
    if r.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"OpenAI Assembly Inspect error {r.status_code}: {r.text[:1200]}")
    data = r.json()
    texts = [p.get("text", "") for item in data.get("output", []) if item.get("type") == "message" for p in item.get("content", []) if p.get("type") == "output_text" and p.get("text")]
    return _extract_json("\n".join(texts)), model


@app.post("/api/assembly_inspect")
def assembly_inspect(req: AssemblyInspectRequest):
    if len(req.board_image) > MAX_IMAGE_CHARS or len(req.placement_map_image) > MAX_MAP_CHARS:
        raise HTTPException(status_code=413, detail="装配检查图像过大")
    if not req.footprints:
        raise HTTPException(status_code=400, detail="没有从 KiCad PCB 提取到 footprint 位置数据")
    provider = req.provider.lower().strip()
    if provider == "gemini":
        result, model = _gemini(req)
    elif provider == "openai":
        result, model = _openai(req)
    else:
        raise HTTPException(status_code=400, detail="provider 仅支持 gemini/openai")
    return {"ok": True, "mode": "assembly_inspect", "provider": provider, "model": model, "result": result}
