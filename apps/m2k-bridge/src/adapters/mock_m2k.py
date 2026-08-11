"""Synthesised ADALM2000. No hardware, no libm2k.

Scenario values come from docs/05 section 11.1. Noise uses a fixed seed
derived from the sequence number so a demo replays identically - a recording
made today must look the same tomorrow.
"""

from __future__ import annotations

import numpy as np

from .awg_plan import WAVES, plan_awg_buffer
from .base import (
    DEFAULT_SAMPLES,
    AdapterError,
    AwgConfig,
    DeviceStatus,
    ScopeConfig,
    ScopeFrame,
    check_hardware_limits,
)

try:
    from ..scenarios import FREQ_HZ, SPECS, measure, synthesize
except ImportError:  # pragma: no cover - packaged (PyInstaller) run
    from scenarios import FREQ_HZ, SPECS, measure, synthesize


class MockM2kAdapter:
    name = "mock"

    def __init__(self, scenario: str = "gain_error") -> None:
        self._scenario = scenario
        self._running = True
        self._connected = True
        self._sample_rate = 1_000_000.0
        self._awg: AwgConfig | None = None
        self._awg_enabled = False

    # -- scenario control (mock only) ------------------------------------

    @property
    def scenario(self) -> str:
        return self._scenario

    def set_scenario(self, scenario: str) -> None:
        if scenario not in SPECS:
            raise AdapterError(f"未知场景 {scenario}", "UNKNOWN_SCENARIO")
        self._scenario = scenario

    # -- adapter interface -----------------------------------------------

    def status(self) -> DeviceStatus:
        return DeviceStatus(
            connected=self._connected,
            device="ADALM2000",
            serial="104122A8BC2F",
            firmware="0.39",
            mock=True,
            running=self._running,
            scenario=self._scenario,
        )

    def list_devices(self) -> list[dict]:
        return [{"uri": "mock://m2k", "name": "ADALM2000 (mock)"}]

    def connect(self, uri: str | None = None) -> DeviceStatus:
        self._connected = True
        return self.status()

    def disconnect(self) -> None:
        self._connected = False

    def configure_awg(self, config: AwgConfig) -> dict:
        """返回形状与真实适配器一致 —— 但**不谎报频率**。

        mock 是场景回放，波形固定在 scenarios.FREQ_HZ（1kHz），不管请求什么频率。
        所以 `actualFreqHz` 报的是场景的实际频率，不是请求值：请求 5kHz 时
        它会显示 1000，误差 400% —— 这正是真相。
        `simulated: true` 让调用方一眼看出这不是真实器件的输出。

        两个 adapter 返回同一形状，是为了让 hardware_smoke 这类工具不必分支；
        形状一致不等于内容可以造假。
        """
        check_hardware_limits(config)
        if config.wave not in WAVES:
            raise AdapterError(
                f"不支持的波形 {config.wave}，可选：{', '.join(WAVES)}", "WAVEFORM_UNSUPPORTED"
            )
        # 频率也用同一个规划器校验。mock 不靠它合成波形（它是场景回放），
        # 但**拒绝行为必须和真机一致**：mock 上能配成的频率，真机上也要能配成。
        # 否则在 mock 上试通了的操作，接上硬件就报错，人会以为是硬件问题。
        if config.wave != "dc":
            try:
                plan_awg_buffer(config.freq_hz)
            except ValueError as exc:
                raise AdapterError(str(exc), "FREQ_UNREACHABLE") from exc

        self._awg = config
        self._awg_enabled = True

        actual = 0.0 if config.wave == "dc" else FREQ_HZ
        err = 0.0 if config.freq_hz <= 0 else abs(actual - config.freq_hz) / config.freq_hz * 100.0
        return {
            "applied": True,
            "simulated": True,
            "channel": config.channel,
            "wave": config.wave,
            "amplitudeVpp": config.amplitude_vpp,
            "offsetV": config.offset_v,
            "requestedFreqHz": config.freq_hz,
            # 场景波形固定 1kHz，不随请求变 —— 报真话，别报请求值
            "actualFreqHz": actual,
            "freqErrorPct": round(err, 4),
            "awg": config.__dict__,
        }

    def disable_awg(self) -> None:
        self._awg_enabled = False

    def configure_scope(self, config: ScopeConfig) -> dict:
        if config.sample_rate <= 0:
            raise AdapterError("采样率必须为正", "INVALID_CONFIG")
        self._sample_rate = config.sample_rate
        self._running = config.running
        return {
            "applied": True,
            "sampleRate": config.sample_rate,
            "running": config.running,
        }

    def read_scope_frame(self, sequence: int, samples: int = DEFAULT_SAMPLES) -> ScopeFrame:
        if not self._running:
            raise AdapterError("示波器已停止", "NOT_RUNNING")
        ch1, ch2 = synthesize(
            self._scenario,
            sample_rate=self._sample_rate,
            samples=samples,
            sequence=sequence,
        )
        return ScopeFrame(
            ch1=ch1,
            ch2=ch2,
            sample_rate=self._sample_rate,
            sequence=sequence,
            measurements=measure(ch1, ch2, self._sample_rate),
        )

    def emergency_stop(self) -> None:
        self._awg_enabled = False
        self._running = False
