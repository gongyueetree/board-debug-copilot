"""AWG buffer planning and waveform synthesis.

Pure functions, no libm2k, no hardware. That is the point: the frequency
planning is where the old implementation was **wrong**, not merely unverified,
and pure maths can be tested exhaustively right now. What is left for the bench
is only the libm2k plumbing.

── 老实现错在哪 ──────────────────────────────────────────────

    self._aout.setSampleRate(idx, 75_000_000)
    n = 1024
    samples = offset + (vpp/2) * np.sin(linspace(0, 2*pi, n))

ADALM2000 的 AWG 是**循环推缓冲**：把 N 个点以采样率 r 循环播放，
输出频率就是 r/N。写死 75MSPS / 1024 点 → 输出恒为 73.2kHz，
和请求的 freq_hz 毫无关系。请求 1kHz 得到 73kHz，而接口返回 200 ——
调用方完全看不出来。

── 现在怎么做 ────────────────────────────────────────────────

缓冲里放 **k 个整周期**，输出频率 = k * r / N。
对每个可用采样率、每个 k 试一遍，挑频率误差最小的组合。

放多周期不是花哨：单周期时 10MHz 在 75MSPS 下只能取 N=7 或 8
（9.375MHz，误差 6%）；k=4 时 N=30，正好 10MHz，误差 0。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

#: ADALM2000 的 AWG 可用采样率。运行时优先问设备要（getAvailableSampleRates），
#: 问不到才用这份 —— 不同固件可能不一样。
DEFAULT_AWG_RATES: tuple[float, ...] = (750.0, 7500.0, 75_000.0, 750_000.0, 7_500_000.0, 75_000_000.0)

#: ADALM2000 的示波器可用采样率
DEFAULT_SCOPE_RATES: tuple[float, ...] = (
    1_000.0, 10_000.0, 100_000.0, 1_000_000.0, 10_000_000.0, 100_000_000.0,
)

MIN_SAMPLES = 16
MAX_SAMPLES = 16_384
#: 每周期少于这么多点，波形已经不成形（方波还行，正弦就是折线了）
MIN_SAMPLES_PER_CYCLE = 4

WAVES = ("sine", "square", "triangle", "sawtooth", "dc")


@dataclass(frozen=True)
class AwgPlan:
    sample_rate: float
    samples: int
    cycles: int
    #: 实际能输出的频率。**和请求值可能不同，必须回报给调用方。**
    actual_freq_hz: float
    requested_freq_hz: float

    @property
    def freq_error_pct(self) -> float:
        if self.requested_freq_hz <= 0:
            return 0.0
        return abs(self.actual_freq_hz - self.requested_freq_hz) / self.requested_freq_hz * 100.0

    @property
    def samples_per_cycle(self) -> float:
        return self.samples / self.cycles

    def describe(self) -> dict:
        return {
            "sampleRate": self.sample_rate,
            "samples": self.samples,
            "cycles": self.cycles,
            "actualFreqHz": round(self.actual_freq_hz, 4),
            "requestedFreqHz": self.requested_freq_hz,
            "freqErrorPct": round(self.freq_error_pct, 4),
            "samplesPerCycle": round(self.samples_per_cycle, 2),
        }


def plan_awg_buffer(
    freq_hz: float,
    available_rates: tuple[float, ...] | list[float] = DEFAULT_AWG_RATES,
    *,
    min_samples: int = MIN_SAMPLES,
    max_samples: int = MAX_SAMPLES,
    max_cycles: int = 64,
    min_samples_per_cycle: int = MIN_SAMPLES_PER_CYCLE,
) -> AwgPlan:
    """挑 (采样率, 缓冲长度, 周期数) 使输出频率最接近 freq_hz。

    评分：先看频率误差，误差相同时取每周期点数多的（波形更平滑）。

    找不到可行组合就抛 ValueError —— **不要退回一个「差不多」的频率然后
    假装成功**，那正是老实现的问题。调用方需要知道这个频率做不到。
    """
    if freq_hz <= 0:
        raise ValueError("频率必须为正")

    rates = sorted({float(r) for r in available_rates if r > 0}, reverse=True)
    if not rates:
        raise ValueError("没有可用的采样率")

    best: AwgPlan | None = None
    best_key: tuple[float, float] | None = None

    for rate in rates:
        for k in range(1, max_cycles + 1):
            exact = k * rate / freq_hz
            n = int(round(exact))
            if n < min_samples or n > max_samples:
                continue
            if n / k < min_samples_per_cycle:
                continue
            actual = k * rate / n
            err = abs(actual - freq_hz) / freq_hz
            # 误差升序、每周期点数降序
            key = (err, -(n / k))
            if best_key is None or key < best_key:
                best_key = key
                best = AwgPlan(
                    sample_rate=rate,
                    samples=n,
                    cycles=k,
                    actual_freq_hz=actual,
                    requested_freq_hz=freq_hz,
                )
            if err == 0.0 and k == 1:
                break  # 单周期就精确，没有更好的了

    if best is None:
        lo = min(rates) / max_samples
        hi = max(rates) / min_samples_per_cycle
        raise ValueError(
            f"{freq_hz}Hz 无法用当前采样率合成："
            f"可达范围约 {lo:.4g}Hz ~ {hi:.4g}Hz"
        )
    return best


def synthesize_wave(
    wave: str,
    samples: int,
    cycles: int,
    amplitude_vpp: float,
    offset_v: float,
) -> np.ndarray:
    """按周期数生成一个可循环播放的缓冲，单位伏特。

    首尾必须能接上：用 `arange(n)/n` 而不是 `linspace(0, 2π, n)` ——
    后者把终点也算进去，循环播放时每圈会重复一个点，产生周期性的小毛刺。
    """
    if wave not in WAVES:
        raise ValueError(f"不支持的波形 {wave}，可选：{', '.join(WAVES)}")
    if samples <= 0:
        raise ValueError("缓冲长度必须为正")

    half = amplitude_vpp / 2.0
    if wave == "dc":
        return np.full(samples, offset_v, dtype=float)

    # 归一化相位 [0,1)，含 cycles 个整周期，首尾可无缝衔接
    ph = (np.arange(samples, dtype=float) * cycles / samples) % 1.0

    if wave == "sine":
        y = np.sin(2 * np.pi * ph)
    elif wave == "square":
        # 用 where 而不是 sign：sign(0)=0 会在过零点插一个 0V 的点
        y = np.where(ph < 0.5, 1.0, -1.0)
    elif wave == "triangle":
        # 0→1→0→-1→0，峰值 ±1
        y = 4.0 * np.abs(ph - 0.5) - 1.0
        y = -y  # 让相位 0 处从 -1 上升，与 sine 的起始方向一致
    else:  # sawtooth
        y = 2.0 * ph - 1.0

    return offset_v + half * y


def nearest_sample_rate(
    requested: float,
    available: tuple[float, ...] | list[float] = DEFAULT_SCOPE_RATES,
) -> float:
    """挑最接近的可用采样率。

    示波器采样率是分档的，请求 1MSPS 未必能精确落到。返回实际值让调用方
    回报出去 —— 采样率报错了，下游算出来的频率就全错。
    """
    rates = sorted({float(r) for r in available if r > 0})
    if not rates:
        raise ValueError("没有可用的采样率")
    return min(rates, key=lambda r: (abs(r - requested), r))
