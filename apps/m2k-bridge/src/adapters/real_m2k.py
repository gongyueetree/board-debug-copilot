"""Real ADALM2000 over libm2k. EXPERIMENTAL — 尚未在真机上跑过。

结构完整、失败分支明确，但**没有任何一行在真实硬件上执行过**。
`status()` 一律返回 `hardware_verified=False`，UI 会显示实验性横幅。
走完 docs/10 的 checklist 之前不要改那个标志。

── 这一版修掉的（都是「写错了」而不是「没验证」）──────────────

1. **`freq_hz` 完全不生效。** 老实现写死 75MSPS / 1024 点，AWG 循环推缓冲的
   输出频率 = 采样率 / 缓冲长度 = 恒 73.2kHz，和请求值无关，而接口还返回 200。
   现在由 `awg_plan.plan_awg_buffer` 算出 (采样率, 点数, 周期数)，
   并把**实际频率**回报给调用方 —— 做不到的频率直接报错，不假装成功。

2. **只有 sine 与 dc。** 方波/三角/锯齿现在都能生成，缓冲首尾可无缝循环。

3. **采样率不落档。** 示波器采样率是分档的，请求 1MSPS 未必精确落到；
   现在取最近档并回报实际值 —— 采样率报错了，下游算的频率全错。

── 仍需实机确认的 ────────────────────────────────────────────

- `getSamples` 的通道顺序、量纲（是否已是伏特）、返回形状
- `setRange` 的档位常量名在当前 libm2k 版本里是否一致
- `calibrateADC/DAC` 的耗时与失败行为
- `getSerialNumber / getFirmwareVersion` 的返回类型

这些地方一律**记进 `notes` 并回报**，而不是静默 try/except ——
同事在真机上看到的应该是「哪一步没成」，不是一个笼统的失败。
"""

from __future__ import annotations

from typing import Any

import numpy as np

from .awg_plan import (
    DEFAULT_AWG_RATES,
    DEFAULT_SCOPE_RATES,
    WAVES,
    nearest_sample_rate,
    plan_awg_buffer,
    synthesize_wave,
)
from .base import (
    DEFAULT_SAMPLES,
    AdapterError,
    AwgConfig,
    DeviceStatus,
    ScopeConfig,
    ScopeFrame,
    check_hardware_limits,
)

_IMPORT_ERROR: str | None = None
try:
    import libm2k  # type: ignore
except ImportError as exc:  # pragma: no cover - depends on host
    libm2k = None  # type: ignore
    _IMPORT_ERROR = str(exc)

class RealM2kAdapter:
    name = "real"

    def __init__(self) -> None:
        self._ctx: Any = None
        self._ain: Any = None
        self._aout: Any = None
        self._uri: str | None = None
        self._running = False
        self._sample_rate = 1_000_000.0
        self._awg_rates: tuple[float, ...] = DEFAULT_AWG_RATES
        self._scope_rates: tuple[float, ...] = DEFAULT_SCOPE_RATES
        #: 可选调用的成败记录。真机排查时这是最有用的一列信息。
        self._notes: list[str] = []
        self._last_awg: dict | None = None

    # -- 内部工具 ---------------------------------------------------------

    def _note(self, msg: str) -> None:
        self._notes.append(msg)
        del self._notes[:-40]  # 只留最近 40 条

    def _try(self, label: str, fn, *args, **kwargs):
        """调用一个「不同 libm2k 版本可能没有」的方法。

        成败都记进 notes。**不静默吞掉** —— 同事需要看到是哪一步没成，
        而不是最后拿到一个笼统的「采集失败」。
        """
        try:
            result = fn(*args, **kwargs)
            self._note(f"[OK ] {label}")
            return result
        except Exception as exc:  # noqa: BLE001 - 这里就是要兜住任意异常并记录
            self._note(f"[SKIP] {label}: {type(exc).__name__}: {exc}")
            return None

    def _require_lib(self) -> None:
        if libm2k is None:
            raise AdapterError(
                "未安装 libm2k。BRIDGE_MOCK=false 需要 libm2k + libiio，"
                f"安装说明见 docs/10 §1（导入错误：{_IMPORT_ERROR}）",
                "LIBM2K_MISSING",
            )

    def _require_device(self):
        self._require_lib()
        if self._ctx is None:
            raise AdapterError(
                "未连接 ADALM2000。先调用 POST /devices/connect，"
                "或确认设备已插好且未被其他程序占用（Scopy 会独占设备）",
                "NO_DEVICE",
            )
        return self._ctx

    # -- adapter interface -----------------------------------------------

    def status(self) -> DeviceStatus:
        base = dict(
            device=None,
            serial=None,
            firmware=None,
            mock=False,
            running=False,
            hardware_verified=False,
            experimental=True,
        )
        if libm2k is None:
            return DeviceStatus(connected=False, detail=f"libm2k 未安装：{_IMPORT_ERROR}", **base)
        if self._ctx is None:
            return DeviceStatus(connected=False, detail="libm2k 可用，但尚未连接设备", **base)

        base.update(
            device="ADALM2000",
            serial=self._try("getSerialNumber", self._ctx.getSerialNumber),
            firmware=self._try("getFirmwareVersion", self._ctx.getFirmwareVersion),
            running=self._running,
        )
        return DeviceStatus(
            connected=True,
            detail="实验性真实硬件模式，尚未经过实机验证",
            **base,
        )

    def list_devices(self) -> list[dict]:
        if libm2k is None:
            # 不能返回空列表：操作者会看到「没发现设备」，然后去查 USB 线、
            # 查 Scopy 有没有占用，而真正的原因是库根本没装。
            raise AdapterError(
                f"libm2k 未安装，无法枚举设备：{_IMPORT_ERROR}。安装步骤见 docs/10 §1",
                "LIBM2K_MISSING",
            )
        try:
            uris = libm2k.getAllContexts()
        except Exception as exc:  # pragma: no cover - depends on host
            raise AdapterError(f"设备枚举失败：{exc}", "ENUMERATION_FAILED") from exc
        return [{"uri": u, "name": "ADALM2000"} for u in uris]

    def connect(self, uri: str | None = None) -> DeviceStatus:
        self._require_lib()
        self._notes.clear()
        try:
            self._ctx = libm2k.m2kOpen(uri) if uri else libm2k.m2kOpen()
            if self._ctx is None:
                raise AdapterError(
                    "未找到 ADALM2000。检查 USB 连接（充电线不行，要数据线），"
                    "并确认 Scopy 等程序未占用设备",
                    "NO_DEVICE",
                )
            # 校准可能耗时若干秒，也可能在某些固件上不存在 —— 失败不该让连接失败，
            # 但必须记下来：没校准的读数会有偏差，同事得知道。
            self._try("calibrateADC", self._ctx.calibrateADC)
            self._try("calibrateDAC", self._ctx.calibrateDAC)

            self._ain = self._ctx.getAnalogIn()
            self._aout = self._ctx.getAnalogOut()
            self._uri = uri

            # 问设备要真实的可用采样率；问不到就用默认表
            got = self._try("ain.getAvailableSampleRates", self._ain.getAvailableSampleRates)
            if got:
                self._scope_rates = tuple(float(r) for r in got)
            got = self._try("aout.getAvailableSampleRates", self._aout.getAvailableSampleRates, 0)
            if got:
                self._awg_rates = tuple(float(r) for r in got)

            # 两个通道都打开：getSamples 在只开一个通道时的返回形状各版本不一致，
            # 全开可以让形状稳定，代价只是一点带宽。
            for ch in (0, 1):
                self._try(f"ain.enableChannel({ch})", self._ain.enableChannel, ch, True)
            self._try("ain.setKernelBuffersCount", self._ain.setKernelBuffersCount, 1)
        except AdapterError:
            raise
        except Exception as exc:  # pragma: no cover - depends on hardware
            raise AdapterError(f"连接失败：{exc}", "CONNECT_FAILED") from exc
        return self.status()

    def disconnect(self) -> None:
        if self._ctx is not None and libm2k is not None:
            try:
                libm2k.contextClose(self._ctx, True)
            except Exception:  # noqa: BLE001
                self._note("[SKIP] contextClose 失败（设备可能已拔出）")
        self._ctx = self._ain = self._aout = None
        self._running = False

    # -- AWG --------------------------------------------------------------

    def configure_awg(self, config: AwgConfig) -> dict:
        check_hardware_limits(config)
        if config.wave not in WAVES:
            raise AdapterError(
                f"不支持的波形 {config.wave}，可选：{', '.join(WAVES)}", "WAVEFORM_UNSUPPORTED"
            )

        # dc 没有频率概念，其余都要先算出能不能输出这个频率
        plan = None
        if config.wave != "dc":
            try:
                plan = plan_awg_buffer(config.freq_hz, self._awg_rates)
            except ValueError as exc:
                # 做不到就说做不到 —— 老实现在这里悄悄输出了 73kHz
                raise AdapterError(str(exc), "FREQ_UNREACHABLE") from exc

        self._require_device()
        idx = 0 if config.channel == "W1" else 1

        rate = plan.sample_rate if plan else min(self._awg_rates)
        samples = plan.samples if plan else 256
        cycles = plan.cycles if plan else 1

        try:
            self._aout.setSampleRate(idx, rate)
            self._aout.enableChannel(idx, True)
            # 必须显式设循环，否则缓冲播完就停，输出变成一个脉冲
            self._try("aout.setCyclic", self._aout.setCyclic, True)
            buf = synthesize_wave(config.wave, samples, cycles, config.amplitude_vpp, config.offset_v)
            self._aout.push(idx, buf.tolist())
        except AdapterError:
            raise
        except Exception as exc:  # pragma: no cover
            raise AdapterError(f"信号源配置失败：{exc}", "AWG_FAILED") from exc

        applied = {
            "applied": True,
            "channel": config.channel,
            "wave": config.wave,
            "amplitudeVpp": config.amplitude_vpp,
            "offsetV": config.offset_v,
            # 实际频率与请求频率分开报：它们可能不同，调用方必须能看出来
            **(plan.describe() if plan else {"actualFreqHz": 0.0, "requestedFreqHz": config.freq_hz}),
            "notes": list(self._notes[-8:]),
        }
        self._last_awg = applied
        return applied

    def disable_awg(self) -> None:
        if self._aout is None:
            return
        self._try("aout.stop", self._aout.stop)
        self._last_awg = None

    # -- 示波器 -----------------------------------------------------------

    def configure_scope(self, config: ScopeConfig) -> dict:
        self._require_device()
        rate = nearest_sample_rate(config.sample_rate, self._scope_rates)
        try:
            for ch in (0, 1):
                self._ain.enableChannel(ch, True)
            self._ain.setSampleRate(rate)
            self._sample_rate = rate
            self._running = config.running
        except Exception as exc:  # pragma: no cover
            raise AdapterError(f"示波器配置失败：{exc}", "SCOPE_FAILED") from exc

        # 量程档位常量名各版本可能不同，取不到就不设 —— 但要记下来，
        # 因为量程不对会直接表现为「读数是别的量级」
        for ch in (0, 1):
            rng = getattr(libm2k, "PLUS_MINUS_25V", None)
            if rng is not None:
                self._try(f"ain.setRange({ch}, ±25V)", self._ain.setRange, ch, rng)

        return {
            "applied": True,
            "requestedSampleRate": config.sample_rate,
            "sampleRate": rate,
            "running": config.running,
            "notes": list(self._notes[-8:]),
        }

    def read_scope_frame(self, sequence: int, samples: int = DEFAULT_SAMPLES) -> ScopeFrame:
        self._require_device()
        if not self._running:
            raise AdapterError("示波器已停止", "NOT_RUNNING")
        try:
            data = self._ain.getSamples(samples)
        except Exception as exc:  # pragma: no cover
            raise AdapterError(f"采集失败：{exc}", "ACQUIRE_FAILED") from exc

        ch1, ch2 = self._unpack(data, samples)

        try:
            from ..scenarios import measure
        except ImportError:  # pragma: no cover
            from scenarios import measure
        return ScopeFrame(
            ch1=ch1,
            ch2=ch2,
            sample_rate=self._sample_rate,
            sequence=sequence,
            measurements=measure(ch1, ch2, self._sample_rate),
        )

    def _unpack(self, data: Any, samples: int) -> tuple[np.ndarray, np.ndarray]:
        """把 getSamples 的返回拆成两个通道。

        返回形状各版本不一致（两个列表 / 一个交织列表 / numpy 数组），
        而拆错的表现是「波形看起来像噪声」—— 很容易被当成硬件问题。
        所以这里显式判形状，判不出来就报错说清楚看到了什么。
        """
        arr = np.asarray(data, dtype=float)
        if arr.ndim == 2 and arr.shape[0] >= 2:
            return arr[0], arr[1]
        if arr.ndim == 2 and arr.shape[1] >= 2:
            self._note("[NOTE] getSamples 返回列优先，已转置")
            return arr[:, 0], arr[:, 1]
        if arr.ndim == 1 and arr.size >= 2 * samples:
            self._note("[NOTE] getSamples 返回交织数据，已解交织")
            return arr[0::2], arr[1::2]
        if arr.ndim == 1:
            self._note("[NOTE] getSamples 只返回了一个通道，CH2 置零")
            return arr, np.zeros_like(arr)
        raise AdapterError(
            f"无法解析 getSamples 的返回：shape={arr.shape} dtype={arr.dtype}。"
            "请把这行贴进 docs/10 §7，需要按实际形状调整 _unpack",
            "ACQUIRE_FAILED",
        )

    def emergency_stop(self) -> None:
        self.disable_awg()
        self._running = False

    # -- 诊断 -------------------------------------------------------------

    def diagnostics(self) -> dict:
        """一次性把「哪一步成了、哪一步没成」摊开。

        真机排查时，笼统的失败信息最费时间。这里返回可选调用的成败记录、
        实际协商到的采样率、以及最近一次 AWG 的实际输出频率。
        """
        return {
            "libm2k": None if libm2k is None else str(getattr(libm2k, "getVersion", lambda: "unknown")()),
            "connected": self._ctx is not None,
            "uri": self._uri,
            "running": self._running,
            "scopeSampleRate": self._sample_rate,
            "awgAvailableRates": list(self._awg_rates),
            "scopeAvailableRates": list(self._scope_rates),
            "lastAwg": self._last_awg,
            "notes": list(self._notes),
        }
