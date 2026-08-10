"""Instrument adapter interface.

The FastAPI layer must not know whether it is talking to synthesised numpy
data or a real ADALM2000 over libm2k. Everything device-specific lives behind
this protocol so main.py stays a routing layer.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Protocol

import numpy as np

Scenario = Literal["normal", "gain_error", "clipping", "noisy", "no_response"]

# ADALM2000 hard limits. Exceeding these is rejected outright - confirm cannot
# override them, because they are the hardware's limits, not a UI preference.
AWG_MAX_VPP = 10.0
AWG_MAX_OFFSET = 5.0
AWG_MAX_FREQ = 30_000_000.0
SCOPE_MAX_RATE = 100_000_000.0


class AdapterError(Exception):
    """Adapter failure that should surface to the caller with a clear reason."""

    def __init__(self, message: str, code: str = "ADAPTER_ERROR") -> None:
        super().__init__(message)
        self.code = code


@dataclass
class DeviceStatus:
    connected: bool
    device: str | None
    serial: str | None
    firmware: str | None
    mock: bool
    running: bool
    scenario: str | None = None
    #: Populated when the adapter cannot operate, e.g. libm2k missing
    detail: str | None = None


@dataclass
class AwgConfig:
    channel: str = "W1"
    wave: str = "sine"
    freq_hz: float = 1000.0
    amplitude_vpp: float = 0.4
    offset_v: float = 0.0


@dataclass
class ScopeConfig:
    timebase_s_per_div: float = 0.0005
    sample_rate: float = 1_000_000.0
    running: bool = True


@dataclass
class ScopeFrame:
    ch1: np.ndarray
    ch2: np.ndarray
    sample_rate: float
    sequence: int
    measurements: dict = field(default_factory=dict)


class InstrumentAdapter(Protocol):
    """Everything the bridge needs from an instrument backend."""

    name: str

    def status(self) -> DeviceStatus: ...

    def list_devices(self) -> list[dict]: ...

    def connect(self, uri: str | None = None) -> DeviceStatus: ...

    def disconnect(self) -> None: ...

    def configure_awg(self, config: AwgConfig) -> dict: ...

    def disable_awg(self) -> None: ...

    def configure_scope(self, config: ScopeConfig) -> dict: ...

    def read_scope_frame(self, sequence: int) -> ScopeFrame: ...

    def emergency_stop(self) -> None: ...


def requires_confirm(config: AwgConfig) -> bool:
    """Dangerous output needs explicit user confirmation (CLAUDE.md rule 6).

    Enforced in the bridge as well as the UI, because the UI is not the only
    possible caller - anything on localhost can POST here.
    """
    return config.amplitude_vpp > 5.0 or config.offset_v != 0.0


def check_hardware_limits(config: AwgConfig) -> None:
    """Beyond the hardware's range. confirm does not help here."""
    if config.amplitude_vpp > AWG_MAX_VPP:
        raise AdapterError(
            f"幅度 {config.amplitude_vpp}Vpp 超过 ADALM2000 上限 {AWG_MAX_VPP}Vpp",
            "LIMIT_EXCEEDED",
        )
    if abs(config.offset_v) > AWG_MAX_OFFSET:
        raise AdapterError(
            f"偏置 {config.offset_v}V 超过上限 ±{AWG_MAX_OFFSET}V", "LIMIT_EXCEEDED"
        )
    if config.freq_hz > AWG_MAX_FREQ:
        raise AdapterError(
            f"频率 {config.freq_hz}Hz 超过上限 {AWG_MAX_FREQ}Hz", "LIMIT_EXCEEDED"
        )
