#!/usr/bin/env python3
"""Manual hardware smoke test for a real ADALM2000.

Runs the automatable parts of docs/10-adalm2000-hardware-validation.md against a
Bridge that is already running. It is a **人工验证工具**, not an automated test:
it cannot check what a scope on the bench would show, so several rows in the
checklist still have to be filled in by hand.

Safety: no output is enabled by default. The loopback test (W1 -> CH1) needs
--loopback and an interactive confirmation, and it only ever asks for 0.4Vpp
with zero offset - the same values the built-in demo uses. Anything above 5Vpp
or with a DC offset is deliberately out of scope for this script.

    python scripts/hardware_smoke.py                        # 只读检查
    BRIDGE_TOKEN=<token> python scripts/hardware_smoke.py   # 带配对 token
    python scripts/hardware_smoke.py --loopback             # 额外做 W1->CH1
    python scripts/hardware_smoke.py --report out.json      # 存 JSON 报告

配对 token 是 base64url，可能以 `-` 开头，argparse 会把它当成选项。所以要么用
BRIDGE_TOKEN 环境变量（推荐），要么写成 `--token=<token>` 的等号形式。

Exits non-zero if any check fails, so it can gate a manual validation run.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

DEFAULT_BASE = "http://127.0.0.1:3777"


@dataclass
class Check:
    name: str
    ok: bool
    detail: str
    data: dict[str, Any] = field(default_factory=dict)


class Bridge:
    """Tiny HTTP client. urllib on purpose - this script has to run on a bench
    machine where the only guarantee is a stdlib Python."""

    def __init__(self, base: str, token: str | None = None) -> None:
        self.base = base.rstrip("/")
        self.token = token

    def request(
        self, method: str, path: str, body: dict | None = None, auth: bool = True
    ) -> tuple[int, Any]:
        url = f"{self.base}{path}"
        data = json.dumps(body).encode() if body is not None else None
        headers = {"content-type": "application/json"} if data else {}
        if auth and self.token:
            headers["authorization"] = f"Bearer {self.token}"
        req = Request(url, data=data, headers=headers, method=method)
        try:
            with urlopen(req, timeout=10) as res:
                raw = res.read().decode()
                return res.status, json.loads(raw) if raw else None
        except HTTPError as exc:
            raw = exc.read().decode()
            try:
                return exc.code, json.loads(raw) if raw else None
            except json.JSONDecodeError:
                return exc.code, raw
        except URLError as exc:
            raise ConnectionError(f"连不上 Bridge（{url}）：{exc.reason}") from exc


def code_of(payload: Any) -> str | None:
    """Bridge 的错误体是 {"detail": {"code": ..., "message": ...}}"""
    if isinstance(payload, dict):
        detail = payload.get("detail")
        if isinstance(detail, dict):
            return detail.get("code")
    return None


# ---------------------------------------------------------------- checks


def check_status(b: Bridge) -> tuple[Check, dict]:
    status, body = b.request("GET", "/status", auth=False)
    if status != 200 or not isinstance(body, dict):
        return Check("/status 可达", False, f"HTTP {status}"), {}

    problems = []
    if body.get("mock") is not False:
        problems.append("mock 不是 false —— Bridge 没跑在 BRIDGE_MOCK=false 下")
    if body.get("adapter") != "real":
        problems.append(f"adapter={body.get('adapter')}，期望 real")
    if body.get("hardwareVerified") is not False:
        problems.append("hardwareVerified 不是 false —— checklist 没跑完就不该改它")

    detail = (
        f"adapter={body.get('adapter')} connected={body.get('connected')} "
        f"device={body.get('device')} serial={body.get('serial')} "
        f"firmware={body.get('firmware')}"
    )
    if body.get("detail"):
        detail += f" | {body['detail']}"

    return Check("/status 报告真实适配器", not problems, "；".join(problems) or detail, body), body


def check_pairing_required(b: Bridge) -> list[Check]:
    """未配对时控制面必须全关。用一个不带 token 的客户端试。"""
    anon = Bridge(b.base, token=None)
    out: list[Check] = []
    for method, path, body in [
        ("GET", "/devices", None),
        ("POST", "/scope", {"sampleRate": 1000000, "running": False}),
        ("POST", "/awg", {"channel": "W1", "wave": "sine", "freqHz": 1000, "amplitudeVpp": 0.4}),
    ]:
        status, payload = anon.request(method, path, body, auth=False)
        ok = status == 401 and code_of(payload) == "NOT_PAIRED"
        out.append(
            Check(f"未配对拒绝 {method} {path}", ok, f"HTTP {status} code={code_of(payload)}")
        )
    return out


def check_emergency_stop(b: Bridge) -> Check:
    """急停必须无需 token —— 因 token 过期而失效的急停比没有急停更糟。"""
    anon = Bridge(b.base, token=None)
    status, payload = anon.request("POST", "/emergency-stop", auth=False)
    ok = status == 200 and isinstance(payload, dict) and payload.get("stopped") is True
    return Check("急停无需 token 且返回 stopped", ok, f"HTTP {status} {payload}")


def check_token(b: Bridge) -> Check:
    """先确认 token 本身有效。

    token 过期时后面每一项都会 401，输出成一串「设备列不出来」，
    读起来像硬件坏了。先单独报一句，省得照着错方向排查。
    """
    status, payload = b.request("GET", "/devices")
    if status == 401:
        return Check(
            "配对 token 有效",
            False,
            "401 NOT_PAIRED —— token 无效或已过期，重新走一次 "
            "POST /pairing/start → 看 Bridge 控制台的 6 位码 → POST /pairing/verify",
        )
    return Check("配对 token 有效", True, f"HTTP {status}")


def check_devices(b: Bridge) -> tuple[Check, list]:
    status, body = b.request("GET", "/devices")
    if status != 200 or not isinstance(body, dict):
        return Check("/devices 列出设备", False, f"HTTP {status} {body}"), []
    devices = body.get("devices") or []
    return (
        Check("/devices 列出设备", len(devices) > 0, f"{len(devices)} 个：{devices}", body),
        devices,
    )


def check_connect(b: Bridge) -> Check:
    status, body = b.request("POST", "/devices/connect")
    if status != 200 or not isinstance(body, dict):
        return Check("连接设备", False, f"HTTP {status} code={code_of(body)} {body}")
    return Check("连接设备", bool(body.get("connected")), json.dumps(body, ensure_ascii=False))


def check_scope_config(b: Bridge) -> Check:
    status, body = b.request(
        "POST", "/scope", {"sampleRate": 1_000_000, "timebaseSPerDiv": 0.0005, "running": True}
    )
    ok = status == 200
    # 实际生效的采样率要人工核对：ADALM2000 的采样率是分档的
    return Check("配置示波器 1MSPS", ok, f"HTTP {status} {json.dumps(body, ensure_ascii=False)}")


def check_waveform_support(b: Bridge) -> list[Check]:
    """五种波形都要能配上，且**回报的实际频率必须接近请求值**。

    这是老实现最严重的缺陷：写死 75MSPS/1024 点，无论请求多少都输出
    73.2kHz，接口还返回 200。所以这里不只看 HTTP 状态，要看 actualFreqHz。
    """
    out: list[Check] = []
    for wave in ("sine", "square", "triangle", "sawtooth", "dc"):
        status, payload = b.request(
            "POST",
            "/awg",
            {"channel": "W1", "wave": wave, "freqHz": 1000, "amplitudeVpp": 0.4, "offsetV": 0},
        )
        if status != 200 or not isinstance(payload, dict):
            out.append(Check(f"{wave} 波形可配置", False, f"HTTP {status} code={code_of(payload)}"))
            continue

        if wave == "dc":
            out.append(Check("dc 波形可配置", True, "HTTP 200（无频率概念）"))
            continue

        actual = payload.get("actualFreqHz")
        err = payload.get("freqErrorPct")
        ok = isinstance(actual, (int, float)) and abs(float(actual) - 1000.0) < 1.0
        out.append(
            Check(
                f"{wave} 实际频率 ≈ 请求值",
                ok,
                f"请求 1000Hz → 实际 {actual}Hz 误差 {err}% "
                f"(rate={payload.get('sampleRate')} N={payload.get('samples')} k={payload.get('cycles')})"
                + ("" if ok else " —— 频率规划有问题，见 awg_plan.py"),
            )
        )

    # 做不到的频率要显式报错，不能凑一个
    status, payload = b.request(
        "POST", "/awg", {"channel": "W1", "wave": "sine", "freqHz": 25_000_000, "amplitudeVpp": 0.4}
    )
    out.append(
        Check(
            "做不到的频率报 FREQ_UNREACHABLE",
            code_of(payload) == "FREQ_UNREACHABLE",
            f"HTTP {status} code={code_of(payload)}",
        )
    )
    return out


def check_limit_guards(b: Bridge) -> list[Check]:
    """超硬件上限与需二次确认，两条独立规则。"""
    out: list[Check] = []

    status, payload = b.request(
        "POST",
        "/awg",
        # confirm 也不该绕过硬件上限：确认过的 20Vpp 依然是不可能的
        {"channel": "W1", "wave": "sine", "freqHz": 1000, "amplitudeVpp": 20, "confirm": True},
    )
    out.append(
        Check(
            "20Vpp 被拒（confirm 绕不过）",
            status == 422 and code_of(payload) == "LIMIT_EXCEEDED",
            f"HTTP {status} code={code_of(payload)}",
        )
    )

    status, payload = b.request(
        "POST",
        "/awg",
        {"channel": "W1", "wave": "sine", "freqHz": 1000, "amplitudeVpp": 6, "offsetV": 0},
    )
    out.append(
        Check(
            "6Vpp 无 confirm 被拒（428）",
            status == 428 and code_of(payload) == "CONFIRM_REQUIRED",
            f"HTTP {status} code={code_of(payload)}",
        )
    )

    status, payload = b.request(
        "POST",
        "/awg",
        {"channel": "W1", "wave": "dc", "freqHz": 0, "amplitudeVpp": 0, "offsetV": 2.5},
    )
    out.append(
        Check(
            "offset 2.5V 无 confirm 被拒（428）",
            status == 428 and code_of(payload) == "CONFIRM_REQUIRED",
            f"HTTP {status} code={code_of(payload)}",
        )
    )
    return out


def check_loopback(b: Bridge) -> list[Check]:
    """W1 → CH1 直连，**采一帧回来对比**。这才是「数据通道通了没有」的答案。

    只请求 0.4Vpp / 0 offset，和内置 Demo 的默认值一致。结束后一定 disable。
    """
    out: list[Check] = []
    freq, vpp = 1000.0, 0.4

    status, awg = b.request(
        "POST",
        "/awg",
        {"channel": "W1", "wave": "sine", "freqHz": freq, "amplitudeVpp": vpp, "offsetV": 0},
    )
    ok = status == 200 and isinstance(awg, dict)
    out.append(
        Check(
            "W1 输出 0.4Vpp/1kHz sine",
            ok,
            f"HTTP {status} 实际频率 {awg.get('actualFreqHz') if ok else '—'}Hz",
        )
    )
    if not ok:
        return out

    try:
        status, _ = b.request("POST", "/scope", {"sampleRate": 1_000_000, "running": True})
        out.append(Check("启动示波器", status == 200, f"HTTP {status}"))
        time.sleep(0.5)

        status, body = b.request("POST", "/scope/measure", {"samples": 4096})
        if status != 200 or not isinstance(body, dict):
            out.append(Check("采集一帧", False, f"HTTP {status} {body}"))
            return out

        m = body.get("measurements", {})
        c1 = m.get("ch1", {})
        got_vpp = float(c1.get("vpp", 0) or 0)
        got_freq = float(c1.get("freqHz", 0) or 0)

        out.append(
            Check("采集一帧", True, f"{body.get('samples')} 点 @ {body.get('sampleRate')}Sa/s")
        )
        # ±20% 是宽松的：探头衰减、量程档位、接触电阻都会影响幅度。
        # 这一步要回答的是「通道通不通」，精确标定是人工那一步的事。
        out.append(
            Check(
                "CH1 测到幅度 ≈ W1 输出",
                abs(got_vpp - vpp) <= vpp * 0.2,
                f"输出 {vpp}Vpp → 测到 {got_vpp}Vpp"
                + ("" if abs(got_vpp - vpp) <= vpp * 0.2 else " —— 量程档位或单位可能不对"),
            )
        )
        out.append(
            Check(
                "CH1 测到频率 ≈ W1 输出",
                abs(got_freq - freq) <= freq * 0.05,
                f"输出 {freq}Hz → 测到 {got_freq}Hz"
                + ("" if abs(got_freq - freq) <= freq * 0.05 else " —— 采样率或频率规划有问题"),
            )
        )

        print("\n  >>> 同时用独立示波器量一下 W1，确认和上面的数字对得上")
        print("  >>> 通道顺序、单位、空载噪声这几项脚本量不了，见 docs/10 §3")
        input("  >>> 记录完按回车，脚本会关闭输出：")
    finally:
        status, _ = b.request("POST", "/awg/disable")
        out.append(Check("关闭 W1 输出", status == 200, f"HTTP {status}"))
    return out


# ---------------------------------------------------------------- main


def main() -> int:
    ap = argparse.ArgumentParser(description="ADALM2000 真实硬件冒烟检查")
    ap.add_argument("--base", default=DEFAULT_BASE, help=f"Bridge 地址（默认 {DEFAULT_BASE}）")
    # token 可能以 - 开头（base64url），`--token <值>` 会被 argparse 当成选项。
    # 用 BRIDGE_TOKEN 环境变量或 `--token=<值>` 都能绕开。
    ap.add_argument(
        "--token",
        default=os.getenv("BRIDGE_TOKEN"),
        help="配对 token（也可用 BRIDGE_TOKEN 环境变量）。不给就只跑不需要 token 的检查",
    )
    ap.add_argument("--loopback", action="store_true", help="额外做 W1->CH1，会真的开输出")
    ap.add_argument("--report", help="把 JSON 报告写到这个文件")
    args = ap.parse_args()

    bridge = Bridge(args.base, args.token)
    checks: list[Check] = []
    status_body: dict = {}

    print(f"ADALM2000 硬件冒烟检查\n  Bridge {args.base}\n")

    try:
        c, status_body = check_status(bridge)
        checks.append(c)

        # 安全拦截先跑：确认控制面是关着的，再谈连设备
        checks.extend(check_pairing_required(bridge))
        checks.append(check_emergency_stop(bridge))

        if not args.token:
            print("  ! 没给 --token，跳过所有需要配对的检查")
            print("    先 POST /pairing/start，看 Bridge 控制台的 6 位码，再 POST /pairing/verify\n")
        else:
            tok = check_token(bridge)
            checks.append(tok)
            if not tok.ok:
                for c in checks:
                    print(f"  {'✓' if c.ok else '✗'} {c.name:<38} {c.detail}")
                print("\n配对失败，后续硬件检查全部跳过。")
                return 1

            c, devices = check_devices(bridge)
            checks.append(c)
            if devices:
                checks.append(check_connect(bridge))
                checks.append(check_scope_config(bridge))
                checks.extend(check_waveform_support(bridge))
                checks.extend(check_limit_guards(bridge))
                if args.loopback:
                    print("\n  !! W1 会真实输出 0.4Vpp。确认 W1 已直连 CH1，且没接被测板卡。")
                    if input("  !! 输入 yes 继续：").strip().lower() == "yes":
                        checks.extend(check_loopback(bridge))
                    else:
                        print("  已跳过 loopback")
            else:
                print("  ! 没发现设备，跳过后续硬件检查")
    except ConnectionError as exc:
        # 不接硬件/没起 Bridge 是最常见的情况，要给清晰的下一步而不是堆栈
        print(f"  ✗ {exc}")
        print("\n  先起 Bridge：")
        print("    cd apps/m2k-bridge && BRIDGE_MOCK=false .venv/bin/uvicorn src.main:app --port 3777")
        print("  安装与排查见 docs/10-adalm2000-hardware-validation.md")
        return 2

    for c in checks:
        print(f"  {'✓' if c.ok else '✗'} {c.name:<38} {c.detail}")

    failed = [c for c in checks if not c.ok]
    print(f"\n{len(checks) - len(failed)}/{len(checks)} 通过")

    diag = None
    if args.token:
        try:
            _, diag = bridge.request("GET", "/diagnostics")
        except ConnectionError:
            diag = None

    if args.report:
        report = {
            "base": args.base,
            "status": status_body,
            # 每个可选 libm2k 调用的成败都在这里 —— 真机排查最有用的一列
            "diagnostics": diag,
            "loopback": args.loopback,
            "checks": [{"name": c.name, "ok": c.ok, "detail": c.detail} for c in checks],
            "passed": len(checks) - len(failed),
            "total": len(checks),
        }
        with open(args.report, "w", encoding="utf-8") as fh:
            json.dump(report, fh, ensure_ascii=False, indent=2)
        print(f"报告已写入 {args.report}")

    print("\n注意：示波器读数、实际输出频率、通道顺序、单位这几项脚本量不了，")
    print("      必须人工用独立示波器核对并填进 docs/10 第 7 节。")
    print("      整份 checklist 走完之前，hardwareVerified 保持 false。")

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
