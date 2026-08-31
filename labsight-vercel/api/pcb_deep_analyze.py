from __future__ import annotations

import json
import os
import re
from typing import Any

import requests
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field

from api._security import rate_limit, require_session

app = FastAPI(title="LabSight PCB Deep Vision", version="0.5.4")

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
你是 LabSight PCB 深度视觉分析助手。任务是把高清 PCB 图片转换成工程师可直接使用的结构化事实，而不是泛泛描述。

输入：IMAGE 0 是 PCB 整体；IMAGE 1..N 是高清局部图。

语言要求（非常重要）：
1. 所有面向用户的说明、判断、作用、原因、建议、区域描述、板卡类型都必须使用简体中文。
2. 只有器件型号、芯片顶标、丝印原文、引脚名、网络名、协议缩写和单位（如 RP2040、SWD、GPIO、3V3、12MHz）保留原始英文/数字；不要把完整句子写成英文。
3. 不允许中英文两套描述并列，不要出现英文完整句子。

器件识别方法（核心要求）：
1. 对每个主要 IC，第一步先逐字读取封装顶部可见印字/顶标，marking 必须保存真实看到的字符，不要把推断型号写进 marking。
2. 第二步根据 marking + 封装形态/引脚数 + 周围器件/走线 + PCB 丝印位号 + KiCad 中的 reference/value/net，推断最可能的完整器件型号，写入 likely_part。
3. 第三步说明该器件最可能承担的功能，写入 role；不要只说“MCU/电源芯片”这种泛化类别，能判断时写到“USB MCU/3.3V LDO/四路电平转换器/运算放大器”等工程级功能。
4. 如果一个顶标可能对应多个型号，candidates 按可能性从高到低列出 2~4 个候选；likely_part 只填最可能的一个；confidence 反映综合证据强度。
5. observed 只写“实际看到的证据”，例如“顶标 W6X09 C310”“TSSOP-8”“紧邻 12MHz 晶振”；inferred 写“由这些证据推断出的工程判断”，不要混淆观察与推断。
6. 不允许仅凭模糊印字强行给出唯一型号；字符不清楚时应给候选并降低 confidence。
7. 若 KiCad 已明确给出该 reference 对应的型号，应优先用视觉顶标去核对 KiCad，而不是无视工程文件重新猜。

其它识别优先级：
1. 逐字读取板名、丝印、接口/引脚标签、频率、测试点、芯片顶标。
2. 主要 IC、晶振、运放、电源器件尽量给出顶标、候选型号、作用和置信度。
3. 字符部分可见时给候选值，不要因非 100% 确定而省略；observed 与 inferred 分开。
4. 有 KiCad 时与位号、型号、网络交叉核对。
5. 给出“电源/控制 → 核心处理 → 输出”的信号链。

“仍需确认”必须具体：
- 每一项都必须点名具体对象，例如“U5 降压芯片”“Y1 晶振”“左侧 C/D 焊盘”“J3 GPIO 排针”，不能只写“确认芯片型号”“检查接口”等泛化文字。
- 每项写清楚：对象、为什么还不能确认、当前看到了什么、如何确认。
- 如果没有具体对象，就不要输出该项。

“下一步建议”同样必须点名具体对象，并使用中文说明动作与目的。

为了保证 JSON 完整，输出必须精炼并严格限制数量：
- visible_texts 最多 24 项，只保留有工程意义的文字，重复项合并；
- components 最多 12 项；connectors 最多 8 项；
- signal_chain 最多 8 步；uncertain_items 最多 8 项；next_actions 最多 6 项；
- summary 120~250 个中文字；board_function 300 个中文字以内。

必须只返回一个完整 JSON 对象，不要 Markdown，不要解释，不要在 JSON 后追加文字：
{
  "board_identity": {"name":"", "type":"", "confidence":0.0, "evidence":[]},
  "visible_texts": [{"text":"", "kind":"board_title|silkscreen|pin_label|frequency|chip_marking|testpoint|other", "region":"", "confidence":0.0}],
  "components": [{"region":"", "reference":"", "marking":"", "candidates":[], "category":"", "likely_part":"", "role":"", "confidence":0.0, "observed":[], "inferred":[]}],
  "connectors": [{"region":"", "labels":[], "function":"", "confidence":0.0}],
  "signal_chain": [],
  "board_function":"",
  "uncertain_items": [
    {"object":"具体对象", "reason":"不能确认的原因", "observed":"当前可见证据", "how_to_confirm":"具体确认方法"}
  ],
  "next_actions": [
    {"object":"具体对象", "action":"具体动作", "purpose":"为什么做这一步"}
  ],
  "summary":""
}
confidence 范围 0~1。除型号、顶标、丝印、引脚名、网络名、协议缩写和单位外，所有字符串都使用简体中文。
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
            candidate = cleaned[start:end + 1]
            try:
                return json.loads(candidate)
            except json.JSONDecodeError:
                try:
                    return json.loads(re.sub(r",\s*([}\]])", r"\1", candidate))
                except json.JSONDecodeError:
                    pass
    return {
        "summary": "模型返回的结构化结果不完整。请重新执行 PCB 深度视觉分析；原始输出已保留供诊断。",
        "raw_model_output": cleaned,
        "parse_error": True,
    }


def _gemini(req: DeepVisionRequest) -> tuple[dict[str, Any], str, str | None]:
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
        "generationConfig": {
            "temperature": 0.05,
            "maxOutputTokens": 8192,
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
        raise HTTPException(status_code=502, detail=f"Gemini Deep Vision error {r.status_code}: {r.text[:1600]}")
    data = r.json()
    texts = [p.get("text", "") for c in data.get("candidates", []) for p in c.get("content", {}).get("parts", []) if p.get("text")]
    finish = (data.get("candidates") or [{}])[0].get("finishReason")
    result = _extract_json("\n".join(texts))
    if finish == "MAX_TOKENS":
        result["truncated"] = True
        result.setdefault("summary", "Gemini 输出达到长度上限，请重新执行深度视觉分析或缩小识别范围。")
    return result, model, finish


def _openai(req: DeepVisionRequest) -> tuple[dict[str, Any], str, str | None]:
    key = os.getenv("OPENAI_API_KEY")
    if not key:
        raise HTTPException(status_code=503, detail="未配置 OPENAI_API_KEY")
    model = os.getenv("OPENAI_DEEP_VISION_MODEL", os.getenv("OPENAI_VISION_MODEL", "gpt-5.6-luna"))
    content: list[dict[str, Any]] = [{"type": "input_text", "text": DEEP_PROMPT + "\n\n用户要求：" + req.question + "\n\nKiCad 上下文：\n" + _project_text(req.project_context)}]
    for i, image in enumerate([req.overview_image, *req.tile_images]):
        content.append({"type": "input_text", "text": f"IMAGE {i}"})
        content.append({"type": "input_image", "image_url": image, "detail": "high"})
    payload = {"model": model, "input": [{"role": "user", "content": content}], "max_output_tokens": 8192}
    r = requests.post("https://api.openai.com/v1/responses", headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"}, json=payload, timeout=90)
    if r.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"OpenAI Deep Vision error {r.status_code}: {r.text[:1600]}")
    data = r.json()
    texts = [p.get("text", "") for item in data.get("output", []) if item.get("type") == "message" for p in item.get("content", []) if p.get("type") == "output_text" and p.get("text")]
    return _extract_json("\n".join(texts)), model, data.get("status")


@app.post("/api/pcb_deep_analyze")
def pcb_deep_analyze(req: DeepVisionRequest, request: Request):
    require_session(request)
    rate_limit(request, "deepvision", limit=20, window=300.0)
    images = [req.overview_image, *req.tile_images]
    if not 1 <= len(images) <= 7:
        raise HTTPException(status_code=400, detail="深度视觉分析需要 1~7 张图像")
    total_chars = sum(len(x) for x in images)
    if total_chars > MAX_TOTAL_IMAGE_CHARS:
        raise HTTPException(status_code=413, detail=f"深度视觉图像总量过大 ({total_chars} chars)，请降低局部图 JPEG 质量")
    provider = req.provider.lower().strip()
    if provider == "gemini":
        result, model, finish = _gemini(req)
    elif provider == "openai":
        result, model, finish = _openai(req)
    else:
        raise HTTPException(status_code=400, detail="provider 仅支持 gemini/openai")
    return {
        "ok": True,
        "mode": "pcb_deep_vision",
        "provider": provider,
        "model": model,
        "finish_reason": finish,
        "source": {"width": req.source_width, "height": req.source_height, "images": len(images), "payload_chars": total_chars},
        "result": result,
    }
