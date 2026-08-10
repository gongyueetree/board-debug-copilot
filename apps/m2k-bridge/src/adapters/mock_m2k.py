"""Synthesised ADALM2000. No hardware, no libm2k.

Scenario values come from docs/05 section 11.1. Noise uses a fixed seed
derived from the sequence number so a demo replays identically - a recording
made today must look the same tomorrow.
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

try:
    from ..scenarios import SPECS, measure, synthesize
except ImportError:  # pragma: no cover - packaged (PyInstaller) run
    from scenarios import SPECS, measure, synthesize


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
        check_hardware_limits(config)
        self._awg = config
        self._awg_enabled = True
        return {"applied": True, "awg": config.__dict__}

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

    def read_scope_frame(self, sequence: int) -> ScopeFrame:
        if not self._running:
            raise AdapterError("示波器已停止", "NOT_RUNNING")
        ch1, ch2 = synthesize(self._scenario, sample_rate=self._sample_rate, sequence=sequence)
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
