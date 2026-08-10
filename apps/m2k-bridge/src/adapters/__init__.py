"""Instrument adapters. BRIDGE_MOCK selects which one is active."""

from __future__ import annotations

import os

from .base import (
    AdapterError,
    AwgConfig,
    DeviceStatus,
    InstrumentAdapter,
    ScopeConfig,
    ScopeFrame,
    check_hardware_limits,
    requires_confirm,
)
from .mock_m2k import MockM2kAdapter
from .real_m2k import RealM2kAdapter


def create_adapter() -> InstrumentAdapter:
    if os.getenv("BRIDGE_MOCK", "true").lower() == "true":
        return MockM2kAdapter(os.getenv("BRIDGE_SCENARIO", "gain_error"))
    return RealM2kAdapter()


__all__ = [
    "AdapterError",
    "AwgConfig",
    "DeviceStatus",
    "InstrumentAdapter",
    "MockM2kAdapter",
    "RealM2kAdapter",
    "ScopeConfig",
    "ScopeFrame",
    "check_hardware_limits",
    "create_adapter",
    "requires_confirm",
]
