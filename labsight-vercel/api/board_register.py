from __future__ import annotations

import json
import os
import re
from typing import Any, Literal

import requests
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field

from api._security import rate_limit, require_session

app = FastAPI(title="LabSight KiCad Board Registration", version="0.2.0")

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


def _orient(a: Point, b: Point, c: Point) -> float:
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)


def _segments_cross(a: Point, b: Point, c: Point, d: Point) -> bool:
    o1, o2 = _orient(a, b, c), _orient(a, b, d)
    o3, o4 = _orient(c, d, a), _orient(c, d, b)
    return o1 * o2 < -1e-9 and o3 * o4 < -1e-9


def _validate_quad_geometry(points: list[Point]) -> tuple[bool, str]:
    if len(points) != 4:
        return False, "板卡配准必须返回 4 个角点"
    xs, ys = [p.x for p in points], [p.y for p in points]
    if max(xs) - min(xs) < 0.008 or max(ys) - min(ys) < 0.008:
        return False, "板框范围过小"
    if _segments_cross(points[0], points[1], points[2], points[3]) or _segments_cross(points[1], points[2], points[3], points[0]):
        return False, "四角顺序发生交叉"
    area = abs(sum(points[i].x * points[(i + 1) % 4].y - points[(i + 1) % 4].x * points[i].y for i in range(4))) / 2
    if area < 0.00008:
        return False, "板框面积异常"
    edge_lengths = [
        ((points[i].x - points[(i + 1) % 4].x) ** 2 + (points[i].y - points[(i + 1) % 4].y) ** 2) ** 0.5
        for i in range(4)
    ]
    if min(edge_lengths) < 0.006:
        return False, "板框边长异常"
    return True, ""


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
    try:
        bw = max(1e-6, float(req.board_bbox["max_x"]) - float(req.board_bbox["min_x"]))
        bh = max(1e-6, float(req.board_bbox["max_y"]) - float(req.board_bbox["min_y"]))
        aspect = bw / bh
        size_hint = f"{bw:.3f} x {bh:.3f}, aspect={aspect:.5f}"
    except Exception:
        size_hint = "unknown"
    return f"""
你是 LabSight PCB 几何配准器。
IMAGE 0 是摄像头拍到的真实 PCB；IMAGE 1 是从当前 KiCad .kicad_pcb 的 Edge.Cuts/footprint 坐标生成的 placement map。
两张图应代表同一块 PCB。你的任务不是识别器件型号，而是把 KiCad 坐标系准确映射到真实照片。

KiCad board_bbox: {bbox}
KiCad 板框尺寸/比例提示: {size_hint}
部分锚点 footprint（用于判断方向，不要求逐个识别）: {anchors}

请先利用“真实 PCB 基材的外边界/Edge.Cuts 对应边缘”、安装孔、大型连接器、主 IC、晶振等稳定特征判断两张图是否匹配，再给出 IMAGE 0 中真实 PCB 的四个对应角。

非常重要：
1. image_quad 必须落在“PCB 实际基板的四个外边界角”上，不要把丝印文字、焊盘、连接器、Deep Vision ROI 虚线框、阴影或背景桌面当作板框。
2. 如果 PCB 是圆角矩形，请按四条直边的延长交点/切线交点给出四个几何角；不要把圆角切点当成缩小后的板框。
3. IMAGE 0 有透视时，四边可以形成梯形；不要为了看起来像矩形而扩大或缩小真实板框。
4. 输出的四点应尽量满足 KiCad board_bbox 的宽高比例在透视校正后恢复为 {size_hint}。
5. 看不到完整板框或无法确定某个角时，宁可 matched=false，也不要返回包围器件区域的近似大框。

极其重要：image_quad 的四点必须按 IMAGE 1 / KiCad placement map 的方向对应，而不是按照片视觉上的“左上右上”机械排序：
0 = placement map 左上角 (min_x,min_y) 在真实照片中的位置
1 = placement map 右上角 (max_x,min_y) 在真实照片中的位置
2 = placement map 右下角 (max_x,max_y) 在真实照片中的位置
3 = placement map 左下角 (min_x,max_y) 在真实照片中的位置

坐标全部是相对 IMAGE 0 宽高的 0~1 归一化坐标。即使 PCB 在照片里旋转、倾斜或透视，也必须保持以上 KiCad 方向对应关系。
visible_side: 正面器件面为 front，背面为 back，无法判断为 unknown。
只有能较可靠匹配时 matched=true；看不到完整板框、明显不是同一块板或方向无法判断时 matched=false。
evidence 最多 4 条，优先描述“板框/安装孔/大连接器”等几何证据。

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
  "evidence": ["真实 PCB 四条外边界清晰","四个安装孔与 placement map 一致"]
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
            "maxOutputTokens": 650,
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
        "instructions": "只做 PCB 几何配准。四点必须是 PCB 实际 Edge.Cuts 外边界角，不得使用 ROI 框或器件包围框。严格返回 JSON。",
        "input": [{"role": "user", "content": [
            {"type": "input_text", "text": _prompt(req)},
            {"type": "input_image", "image_url": req.board_image, "detail": "high"},
            {"type": "input_image", "image_url": req.placement_map_image, "detail": "high"},
        ]}],
        "max_output_tokens": 650,
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

    if result.matched:
        geometry_ok, geometry_reason = _validate_quad_geometry(result.image_quad)
        if not geometry_ok:
            # 不再把自交/退化四边形交给前端做透视拉伸；这正是小板卡出现条纹和怪异形变的主要来源之一。
            result.matched = False
            result.confidence = min(result.confidence, 0.35)
            result.evidence = (result.evidence + [f"几何校验失败：{geometry_reason}，请重新校准四角"])[:4]

    return {
        "ok": True,
        "mode": "board_registration",
        "provider": provider,
        "model": model,
        "result": result.model_dump(),
    }
