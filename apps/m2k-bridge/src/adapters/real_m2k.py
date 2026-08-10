"""Real ADALM2000 over libm2k. EXPERIMENTAL.

Never exercised against actual hardware. The structure is complete and the
failure modes are explicit, but these in particular are unverified:

  - configure_awg only synthesises sine and dc. square, triangle and sawtooth
    fall back to sine, and the output frequency is not yet derived from
    freq_hz - the sample rate and buffer length together determine it.
  - getSamples channel order, scaling and units are assumed, not confirmed.
  - calibrateADC/calibrateDAC timing and failure behaviour are unconfirmed.
  - getSerialNumber / getFirmwareVersion return shapes are assumed.

Every status() reports hardware_verified=False so the UI can say so. Do not
flip that flag without a device on the bench.

Install notes are in README; libm2k ships as a Python binding over libiio and
is not pip-installable on every platform.
"""

from __future__ import annotations

import numpy as np

from .base import (
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
        self._ctx = None
        self._ain = None
        self._aout = None
        self._uri: str | None = None
        self._running = False
        self._sample_rate = 1_000_000.0

    def _require_lib(self) -> None:
        if libm2k is None:
            raise AdapterError(
                "未安装 libm2k。BRIDGE_MOCK=false 需要 libm2k + libiio，"
                f"安装说明见 apps/m2k-bridge/README.md（导入错误：{_IMPORT_ERROR}）",
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
        if libm2k is None:
            return DeviceStatus(
                connected=False,
                device=None,
                serial=None,
                firmware=None,
                mock=False,
                running=False,
                detail=f"libm2k 未安装：{_IMPORT_ERROR}",
                hardware_verified=False,
                experimental=True,
            )
        if self._ctx is None:
            return DeviceStatus(
                connected=False,
                device=None,
                serial=None,
                firmware=None,
                mock=False,
                running=False,
                detail="libm2k 可用，但尚未连接设备",
                hardware_verified=False,
                experimental=True,
            )
        # TODO(hardware): 用真实设备核对 getSerialNumber / getFirmwareVersion 的返回
        return DeviceStatus(
            connected=True,
            device="ADALM2000",
            serial=getattr(self._ctx, "getSerialNumber", lambda: None)(),
            firmware=getattr(self._ctx, "getFirmwareVersion", lambda: None)(),
            mock=False,
            running=self._running,
            detail="实验性真实硬件模式，尚未经过实机验证",
            hardware_verified=False,
            experimental=True,
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
        try:
            self._ctx = libm2k.m2kOpen(uri) if uri else libm2k.m2kOpen()
            if self._ctx is None:
                raise AdapterError(
                    "未找到 ADALM2000。检查 USB 连接，并确认 Scopy 等程序未占用设备",
                    "NO_DEVICE",
                )
            self._ctx.calibrateADC()
            self._ctx.calibrateDAC()
            self._ain = self._ctx.getAnalogIn()
            self._aout = self._ctx.getAnalogOut()
            self._uri = uri
        except AdapterError:
            raise
        except Exception as exc:  # pragma: no cover - depends on hardware
            raise AdapterError(f"连接失败：{exc}", "CONNECT_FAILED") from exc
        return self.status()

    def disconnect(self) -> None:
        if self._ctx is not None and libm2k is not None:
            try:
                libm2k.contextClose(self._ctx, True)
            except Exception:
                pass
        self._ctx = self._ain = self._aout = None
        self._running = False

    def configure_awg(self, config: AwgConfig) -> dict:
        check_hardware_limits(config)
        # 能力检查和硬件上限一样是静态的，放在设备检查之前：
        # 「不支持方波」比「没插设备」更接近调用方真正要修的东西
        if config.wave not in ("sine", "dc"):
            # 不要静默按正弦输出：调用方会以为自己拿到了方波
            raise AdapterError(
                f"真实硬件模式暂未实现 {config.wave} 波形，目前仅支持 sine 与 dc。"
                "需实机验证后补齐（见 real_m2k.py 头部说明）",
                "WAVEFORM_UNSUPPORTED",
            )
        self._require_device()
        idx = 0 if config.channel == "W1" else 1
        try:
            # TODO(hardware): 输出频率应由 sample_rate 与 buffer 长度共同决定，
            # 当前写死 75MSPS/1024 点，实际频率并不等于 config.freq_hz
            self._aout.setSampleRate(idx, 75_000_000)
            self._aout.enableChannel(idx, True)
            n = 1024
            if config.wave == "dc":
                samples = np.full(n, config.offset_v)
            else:
                t = np.linspace(0, 2 * np.pi, n, endpoint=False)
                samples = config.offset_v + (config.amplitude_vpp / 2) * np.sin(t)
            self._aout.push(idx, samples.tolist())
        except Exception as exc:  # pragma: no cover
            raise AdapterError(f"信号源配置失败：{exc}", "AWG_FAILED") from exc
        return {"applied": True, "awg": config.__dict__}

    def disable_awg(self) -> None:
        if self._aout is None:
            return
        try:
            self._aout.stop()
        except Exception:
            pass

    def configure_scope(self, config: ScopeConfig) -> dict:
        self._require_device()
        try:
            self._ain.enableChannel(0, True)
            self._ain.enableChannel(1, True)
            self._ain.setSampleRate(config.sample_rate)
            self._sample_rate = config.sample_rate
            self._running = config.running
        except Exception as exc:  # pragma: no cover
            raise AdapterError(f"示波器配置失败：{exc}", "SCOPE_FAILED") from exc
        return {"applied": True, "sampleRate": config.sample_rate, "running": config.running}

    def read_scope_frame(self, sequence: int) -> ScopeFrame:
        self._require_device()
        if not self._running:
            raise AdapterError("示波器已停止", "NOT_RUNNING")
        try:
            data = self._ain.getSamples(2048)
            ch1 = np.asarray(data[0], dtype=float)
            ch2 = np.asarray(data[1], dtype=float)
        except Exception as exc:  # pragma: no cover
            raise AdapterError(f"采集失败：{exc}", "ACQUIRE_FAILED") from exc

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

    def emergency_stop(self) -> None:
        self.disable_awg()
        self._running = False
