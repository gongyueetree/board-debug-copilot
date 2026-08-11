"""AWG 频率规划与波形合成。

纯数学，不碰硬件 —— 老实现错的就是这一块（freq_hz 完全不生效），
所以这里可以现在就测透，真机上只剩 libm2k 管道要确认。
"""

from __future__ import annotations

import numpy as np
import pytest

from src.adapters.awg_plan import (
    DEFAULT_AWG_RATES,
    AwgPlan,
    nearest_sample_rate,
    plan_awg_buffer,
    synthesize_wave,
)


@pytest.mark.parametrize(
    "freq",
    [1, 10, 100, 1_000, 1_200, 5_000, 10_000, 50_000, 100_000, 1_000_000, 5_000_000, 10_000_000],
)
def test_common_frequencies_are_exact(freq):
    """常用频率必须精确命中。

    输出频率 = 周期数 * 采样率 / 缓冲长度，这些频率都能整除，误差应为 0。
    """
    plan = plan_awg_buffer(float(freq))
    assert plan.freq_error_pct == pytest.approx(0.0, abs=1e-9)
    assert plan.actual_freq_hz == pytest.approx(float(freq), rel=1e-9)


def test_multi_cycle_buffer_beats_single_cycle_at_high_freq():
    """高频靠多周期缓冲才能精确。

    10MHz 在 75MSPS 下单周期只能取 7 或 8 点（9.375MHz，误差 6%）；
    放 4 个周期共 30 点正好 10MHz。
    """
    plan = plan_awg_buffer(10_000_000.0)
    assert plan.cycles > 1
    assert plan.freq_error_pct == pytest.approx(0.0, abs=1e-9)


def test_unreachable_frequency_raises_instead_of_approximating():
    """做不到就报错，不返回一个「差不多」的。

    老实现在这里悄悄输出 73kHz 并返回 200 —— 调用方完全看不出来。
    """
    with pytest.raises(ValueError, match="无法用当前采样率合成"):
        plan_awg_buffer(50_000_000.0)
    with pytest.raises(ValueError, match="无法用当前采样率合成"):
        plan_awg_buffer(1e-6)


def test_error_message_states_the_reachable_range():
    """报错要告诉调用方能做到什么范围，否则只能靠试。"""
    with pytest.raises(ValueError) as exc:
        plan_awg_buffer(50_000_000.0)
    assert "可达范围" in str(exc.value)


def test_zero_and_negative_frequency_rejected():
    for f in (0.0, -1000.0):
        with pytest.raises(ValueError):
            plan_awg_buffer(f)


def test_buffer_stays_within_device_limits():
    for freq in (1, 1_000, 100_000, 10_000_000):
        plan = plan_awg_buffer(float(freq))
        assert 16 <= plan.samples <= 16_384
        assert plan.samples_per_cycle >= 4
        assert plan.sample_rate in DEFAULT_AWG_RATES


def test_plan_is_deterministic():
    """同一个请求必须给同一个计划，否则排查时对不上。"""
    a = plan_awg_buffer(1000.0)
    b = plan_awg_buffer(1000.0)
    assert a == b


def test_describe_reports_actual_and_requested_separately():
    """实际频率与请求频率必须分开报，调用方要能看出差异。"""
    d = plan_awg_buffer(1000.0).describe()
    assert {"actualFreqHz", "requestedFreqHz", "freqErrorPct", "samplesPerCycle"} <= d.keys()


# -- 波形合成 --------------------------------------------------------------


@pytest.mark.parametrize("wave", ["sine", "square", "triangle", "sawtooth"])
def test_amplitude_and_offset(wave):
    y = synthesize_wave(wave, 4096, 1, 3.0, 1.5)
    assert y.max() - y.min() == pytest.approx(3.0, rel=0.01)
    assert float(np.mean(y)) == pytest.approx(1.5, abs=0.01)


def test_dc_is_flat_at_offset():
    y = synthesize_wave("dc", 256, 1, 5.0, 2.5)
    assert np.allclose(y, 2.5)


@pytest.mark.parametrize("wave", ["sine", "triangle"])
def test_continuous_waves_loop_seamlessly(wave):
    """首尾要接得上：循环播放时接缝处不该有比波形本身更大的跳变。

    用 arange(n)/n 而不是 linspace(0, 2π, n) —— 后者把终点也算进去，
    每圈会重复一个点，产生周期性毛刺。
    """
    y = synthesize_wave(wave, 1000, 1, 2.0, 0.0)
    inside = float(np.max(np.abs(np.diff(y))))
    wrap = abs(float(y[0] - y[-1]))
    assert wrap <= inside * 1.5


def test_sawtooth_flyback_is_expected_not_a_glitch():
    """锯齿的首尾大跳变是回扫沿，是波形定义的一部分，不是接缝问题。"""
    y = synthesize_wave("sawtooth", 1000, 1, 2.0, 0.0)
    assert abs(float(y[0] - y[-1])) > 1.5


def test_square_has_no_zero_crossing_sample():
    """方波不该有落在 0V 的点 —— np.sign(0)=0 会插一个，看起来像过冲前的台阶。"""
    y = synthesize_wave("square", 1000, 1, 2.0, 0.0)
    assert not np.any(np.isclose(y, 0.0))


def test_spectrum_peaks_at_the_intended_frequency():
    """多周期缓冲的频谱峰值必须落在周期数对应的 bin 上。"""
    plan = plan_awg_buffer(10_000_000.0)
    y = synthesize_wave("sine", plan.samples, plan.cycles, 1.0, 0.0)
    peak_bin = int(np.argmax(np.abs(np.fft.rfft(y))))
    assert peak_bin == plan.cycles


def test_unknown_wave_rejected():
    with pytest.raises(ValueError, match="不支持的波形"):
        synthesize_wave("noise", 256, 1, 1.0, 0.0)


# -- 示波器采样率 ----------------------------------------------------------


def test_nearest_sample_rate_snaps_to_available():
    assert nearest_sample_rate(1_000_000.0) == 1_000_000.0
    assert nearest_sample_rate(900_000.0) == 1_000_000.0
    # 档位之间取最近的，不是向上取整
    assert nearest_sample_rate(3_000_000.0) == 1_000_000.0


def test_nearest_sample_rate_is_stable_on_ties():
    """并列时结果必须稳定，否则同样的请求会协商出不同的采样率。"""
    rates = (100.0, 300.0)
    assert nearest_sample_rate(200.0, rates) == nearest_sample_rate(200.0, rates)


# -- 缓冲对齐 --------------------------------------------------------------


@pytest.mark.parametrize(
    "freq", [1, 10, 100, 1_000, 1_200, 5_000, 10_000, 50_000, 100_000, 1_000_000, 5_000_000, 10_000_000]
)
def test_buffer_length_is_four_aligned(freq):
    """循环缓冲按 4 对齐。

    来源是另一份独立 libm2k 实现里的约束。那份也没在真机上跑过，
    但加上它零代价：多周期搜索总能找到既对齐、误差又为 0 的方案。
    """
    from src.adapters.awg_plan import AWG_BUFFER_ALIGN

    plan = plan_awg_buffer(float(freq))
    assert plan.samples % AWG_BUFFER_ALIGN == 0, f"{freq}Hz → N={plan.samples}"


@pytest.mark.parametrize(
    "freq", [1, 10, 100, 1_000, 1_200, 5_000, 10_000, 50_000, 100_000, 1_000_000, 5_000_000, 10_000_000]
)
def test_alignment_costs_no_frequency_accuracy(freq):
    """对齐之后误差仍是 0 —— 这是采纳它的前提。

    如果对齐会让某些频率变得不准，那就得权衡；实测下来不会，
    因为多周期缓冲提供了足够的自由度。
    """
    assert plan_awg_buffer(float(freq)).freq_error_pct == pytest.approx(0.0, abs=1e-9)


def test_alignment_can_be_disabled_for_comparison():
    """留一个开关：真机上若证明不需要对齐，可以关掉再比一次。"""
    aligned = plan_awg_buffer(1_000_000.0)
    raw = plan_awg_buffer(1_000_000.0, align=1)
    assert aligned.samples % 4 == 0
    # 不对齐时 1MHz 会选 k=1/N=75（75 不是 4 的倍数）
    assert raw.samples % 4 != 0 or raw.samples == aligned.samples


def test_describe_reports_alignment():
    assert plan_awg_buffer(1000.0).describe()["bufferAlign"] == 4
