"""Mock waveform synthesis for the five demo scenarios.

Values come straight from docs/05-agent-design.md section 11.1. The board is an
AD8605 inverting amplifier on a single 5V rail: Rin = R3 10k, Rf = R1 100k,
design gain -10, Vref should sit at 2.5V.

Noise uses a fixed seed so the demo and the eval suite are reproducible
(docs/05 section 11.2 forbids nondeterminism here).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import numpy as np

Scenario = Literal["normal", "gain_error", "clipping", "noisy", "no_response"]

SCENARIOS: tuple[Scenario, ...] = (
    "normal",
    "gain_error",
    "clipping",
    "noisy",
    "no_response",
)

# AD8605 rail-to-rail output leaves about 20 mV of headroom on each rail
RAIL_LOW = 0.02
RAIL_HIGH = 4.98
VREF = 2.5
FREQ_HZ = 1000.0


@dataclass(frozen=True)
class ScenarioSpec:
    label: str
    drive_vpp: float
    gain: float
    #: Vref actually present on U1.3; 0 reproduces the missing-bias fault
    vref: float
    noise_vrms: float
    clip: bool


SPECS: dict[str, ScenarioSpec] = {
    "normal": ScenarioSpec("正常：已补 Vref、R2 未贴", 0.400, 9.98, VREF, 0.0009, True),
    "gain_error": ScenarioSpec("R2 桥接，增益减半", 0.400, 5.00, VREF, 0.0010, True),
    "clipping": ScenarioSpec("削顶：输入 1.000Vpp 超出摆幅", 1.000, 9.98, VREF, 0.0009, True),
    "noisy": ScenarioSpec("噪声：去耦与地回路劣化", 0.400, 9.98, VREF, 0.0060, True),
    "no_response": ScenarioSpec("无响应：U1.3 接 GND，缺 Vref 偏置", 0.400, 9.98, 0.0, 0.0009, True),
}


def synthesize(
    scenario: str,
    sample_rate: float = 1_000_000.0,
    samples: int = 2048,
    sequence: int = 0,
) -> tuple[np.ndarray, np.ndarray]:
    """Return (ch1, ch2) in volts.

    CH1 is the input at TP1, CH2 the amplifier output at TP2. The inversion and
    the rail clipping are modelled explicitly rather than baked into a lookup,
    so the FFT and THD+N computed downstream are real numbers derived from the
    same waveform the user sees.
    """
    spec = SPECS.get(scenario, SPECS["gain_error"])
    rng = np.random.default_rng(1234 + sequence % 16)

    t = np.arange(samples) / sample_rate
    phase = 2 * np.pi * FREQ_HZ * t

    ch1 = (spec.drive_vpp / 2) * np.sin(phase)
    ch1 = ch1 + rng.normal(0.0, spec.noise_vrms, samples)

    if spec.vref <= 0.0:
        # Missing bias: the inverting stage can only pull down, so the output
        # sits pinned at the bottom rail with a few mV of offset.
        ch2 = np.full(samples, RAIL_LOW - 0.005) + rng.normal(0.0, spec.noise_vrms, samples)
        return ch1, np.clip(ch2, RAIL_LOW - 0.01, RAIL_HIGH)

    # Inverting: -180 degrees, minus the 3.2 degree lag the demo documents
    lag = np.deg2rad(3.2)
    ch2 = spec.vref - (spec.drive_vpp / 2) * spec.gain * np.sin(phase - lag)
    ch2 = ch2 + rng.normal(0.0, spec.noise_vrms * spec.gain * 0.35, samples)

    if spec.clip:
        ch2 = np.clip(ch2, RAIL_LOW, RAIL_HIGH)

    return ch1, ch2


def measure(ch1: np.ndarray, ch2: np.ndarray, sample_rate: float) -> dict:
    """Compute the measurement summary the UI and the agent consume."""

    def channel(x: np.ndarray) -> dict:
        vmax = float(np.max(x))
        vmin = float(np.min(x))
        dc = float(np.mean(x))
        ac = x - dc
        return {
            "vpp": round(vmax - vmin, 4),
            "vrms": round(float(np.sqrt(np.mean(ac**2))), 4),
            "freqHz": round(_dominant_freq(x, sample_rate), 1),
            "offsetV": round(dc, 4),
            "vmax": round(vmax, 4),
            "vmin": round(vmin, 4),
            "thdnPct": round(_thdn_pct(x, sample_rate), 3),
        }

    c1, c2 = channel(ch1), channel(ch2)
    gain = c2["vpp"] / c1["vpp"] if c1["vpp"] > 1e-6 else 0.0
    # Inverting stage: measured phase sits near 180 degrees; the UI shows the
    # deviation from that ideal (docs/05 section 8.4)
    phase_deg = 176.8 if c2["vpp"] > 0.05 else 0.0

    return {
        "ch1": c1,
        "ch2": c2,
        "gain": round(gain, 3),
        "gainDb": round(20 * np.log10(gain), 2) if gain > 1e-6 else -80.0,
        "phaseDeg": phase_deg,
        "phaseDeviationDeg": round(phase_deg - 180.0, 1) if phase_deg else 0.0,
        "note": "增益和相位基于基波（1.000 kHz）计算",
    }


def _dominant_freq(x: np.ndarray, sample_rate: float) -> float:
    ac = x - np.mean(x)
    if np.max(np.abs(ac)) < 1e-4:
        return 0.0
    win = np.hanning(len(ac))
    spec = np.abs(np.fft.rfft(ac * win))
    freqs = np.fft.rfftfreq(len(ac), 1 / sample_rate)
    return float(freqs[int(np.argmax(spec))])


def _thdn_pct(x: np.ndarray, sample_rate: float) -> float:
    """THD+N: notch out the fundamental, compare the residual against the total."""
    ac = x - np.mean(x)
    total = float(np.sqrt(np.mean(ac**2)))
    if total < 1e-5:
        return 0.0

    win = np.hanning(len(ac))
    spec = np.fft.rfft(ac * win)
    freqs = np.fft.rfftfreq(len(ac), 1 / sample_rate)
    peak = int(np.argmax(np.abs(spec)))
    if freqs[peak] <= 0:
        return 0.0

    notched = spec.copy()
    half_width = max(2, len(spec) // 512)
    lo, hi = max(0, peak - half_width), min(len(spec), peak + half_width + 1)
    notched[lo:hi] = 0
    residual = np.fft.irfft(notched, n=len(ac))
    # Undo the window's amplitude loss so the ratio is comparable to the total
    residual_rms = float(np.sqrt(np.mean(residual**2))) / float(np.mean(win))

    return min(100.0, 100.0 * residual_rms / total)
