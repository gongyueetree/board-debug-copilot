"""WebSocket frame encoding.

Kept out of main.py so the wire format has one owner. Shapes mirror
packages/instrument-protocol; changing either side means changing both.

Binary frames are the eventual goal for high sample counts - the envelope here
is what a binary encoder would slot into.
"""

from __future__ import annotations

import json

from .adapters.base import ScopeFrame

#: Transport decimation. The browser only needs display resolution, and the
#: full-rate array never leaves the bridge process.
DISPLAY_STRIDE = 4


def waveform_frame(frame: ScopeFrame) -> str:
    return json.dumps(
        {
            "type": "waveform",
            "ch1": [round(v, 4) for v in frame.ch1[::DISPLAY_STRIDE].tolist()],
            "ch2": [round(v, 4) for v in frame.ch2[::DISPLAY_STRIDE].tolist()],
            "meta": {
                "fs": frame.sample_rate,
                "ts": frame.sequence * 0.1,
                "sequence": frame.sequence,
            },
        }
    )


def measurements_frame(frame: ScopeFrame) -> str:
    return json.dumps({"type": "measurements", **frame.measurements})


def error_frame(code: str, message: str) -> str:
    return json.dumps({"type": "error", "code": code, "message": message})
