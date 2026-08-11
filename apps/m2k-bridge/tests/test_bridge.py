"""Bridge safety and pairing tests.

These cover the guarantees that must not regress: dangerous output needs
confirmation, hardware limits cannot be confirmed away, and nothing that can
drive hardware works before pairing.
"""

import pytest
from fastapi.testclient import TestClient

from src.main import app, pairing

client = TestClient(app)


@pytest.fixture(autouse=True)
def _reset_state():
    """adapter 与 pairing 都是模块级单例，用例之间必须复位。

    尤其是 emergency-stop 会把示波器停掉 —— 那是正确行为（急停就该要求
    显式重启），但会让后续用例读不到帧。
    """
    from src.adapters.base import ScopeConfig
    from src.main import adapter

    pairing.revoke()
    adapter.configure_scope(ScopeConfig(running=True))
    if hasattr(adapter, "set_scenario"):
        adapter.set_scenario("gain_error")
    yield
    pairing.revoke()


def pair() -> str:
    client.post("/pairing/start")
    # Reach into the manager for the code: it is deliberately only printed to
    # the console, which is the whole point of pairing.
    code = pairing._state.code
    res = client.post("/pairing/verify", json={"code": code})
    assert res.status_code == 200
    return res.json()["token"]


def auth(token: str) -> dict:
    return {"authorization": f"Bearer {token}"}


# -- status ------------------------------------------------------------


def test_status_is_public():
    """The UI must be able to see it is unpaired before it has a token."""
    res = client.get("/status")
    assert res.status_code == 200
    body = res.json()
    assert body["mock"] is True
    assert body["paired"] is False
    assert body["pairingRequired"] is True


# -- pairing -----------------------------------------------------------


def test_control_endpoints_require_pairing():
    for method, path, body in [
        ("post", "/awg", {"amplitudeVpp": 0.4}),
        ("post", "/scope", {}),
        ("get", "/devices", None),
    ]:
        res = getattr(client, method)(path, **({"json": body} if body is not None else {}))
        assert res.status_code == 401, f"{path} 未配对时应 401，实得 {res.status_code}"


def test_pairing_flow_and_revoke():
    token = pair()
    assert client.post("/awg", json={"amplitudeVpp": 0.4}, headers=auth(token)).status_code == 200

    client.post("/pairing/revoke", json={"token": token})
    assert client.post("/awg", json={"amplitudeVpp": 0.4}, headers=auth(token)).status_code == 401


def test_wrong_code_rejected():
    client.post("/pairing/start")
    assert client.post("/pairing/verify", json={"code": "000000"}).status_code in (403, 200)
    # A wrong guess must not produce a working token
    res = client.post("/pairing/verify", json={"code": "999999"})
    if res.status_code == 200:
        pytest.skip("randomly guessed the code")
    assert res.status_code == 403


def test_expired_code_rejected(monkeypatch):
    import time

    client.post("/pairing/start")
    code = pairing._state.code
    monkeypatch.setattr(time, "time", lambda: pairing._state.code_expires_at + 1)
    assert client.post("/pairing/verify", json={"code": code}).status_code == 403


# -- dangerous operations ----------------------------------------------


def test_offset_requires_confirm():
    token = pair()
    res = client.post("/awg", json={"amplitudeVpp": 0.4, "offsetV": 2.5}, headers=auth(token))
    assert res.status_code == 428
    assert res.json()["detail"]["code"] == "CONFIRM_REQUIRED"

    res = client.post(
        "/awg", json={"amplitudeVpp": 0.4, "offsetV": 2.5, "confirm": True}, headers=auth(token)
    )
    assert res.status_code == 200


def test_large_amplitude_requires_confirm():
    token = pair()
    res = client.post("/awg", json={"amplitudeVpp": 6.0}, headers=auth(token))
    assert res.status_code == 428


def test_hardware_limit_cannot_be_confirmed_away():
    """20Vpp is beyond the hardware. confirm must not help."""
    token = pair()
    res = client.post("/awg", json={"amplitudeVpp": 20.0, "confirm": True}, headers=auth(token))
    assert res.status_code == 422, f"期望 422，实得 {res.status_code}"


def test_emergency_stop_needs_no_token():
    """A stop button that fails on an expired token is worse than none."""
    assert client.post("/emergency-stop").status_code == 200


# -- scenario switching is a control surface --------------------------


def test_scenario_switch_requires_pairing():
    """场景切换会改变波形、测量，进而改变 AI 诊断。
    只在 mock 下可用不构成裸露的理由。"""
    res = client.post("/debug/scenario", json={"scenario": "clipping"})
    assert res.status_code == 401, f"未配对切换场景应 401，实得 {res.status_code}"


def test_scenario_switch_works_after_pairing():
    token = pair()
    res = client.post("/debug/scenario", json={"scenario": "clipping"}, headers=auth(token))
    assert res.status_code == 200
    assert res.json()["scenario"] == "clipping"


def test_unpaired_debug_escape_hatch(monkeypatch):
    """CI 与内置 Demo 的显式豁免。BRIDGE_MOCK 本身不是豁免条件。"""
    import src.main as m

    monkeypatch.setattr(m, "ALLOW_UNPAIRED_DEBUG", True)
    assert client.post("/debug/scenario", json={"scenario": "noisy"}).status_code == 200

    # 豁免只对 debug 端点生效，不该顺带打开任何硬件控制面
    for method, path, body in [
        ("post", "/awg", {"amplitudeVpp": 0.4}),
        ("post", "/scope", {}),
        ("get", "/devices", None),
    ]:
        res = getattr(client, method)(path, **({"json": body} if body is not None else {}))
        assert res.status_code == 401, f"豁免不该打开 {path}，实得 {res.status_code}"

    # WebSocket 也一样：它推的是真实采集数据
    with pytest.raises(Exception):
        with client.websocket_connect("/ws") as ws:
            ws.receive_text()


def test_status_reports_escape_hatch():
    """豁免必须可见，不能静默生效。"""
    body = client.get("/status").json()
    assert "allowUnpairedDebug" in body
    assert body["allowUnpairedDebug"] is False


# -- scenarios ---------------------------------------------------------


@pytest.mark.parametrize(
    "scenario,expect_gain,expect_thd_above",
    [
        ("normal", 9.98, None),
        ("gain_error", 5.00, None),
        ("clipping", 4.92, 5.0),
        ("no_response", 0.0, None),
    ],
)
def test_scenario_values(scenario, expect_gain, expect_thd_above):
    """Values come from docs/05 section 11.1. Noise gives a few percent
    spread, so assert a band rather than equality."""
    client.post("/debug/scenario", json={"scenario": scenario}, headers=auth(pair()))
    from src.main import adapter

    frame = adapter.read_scope_frame(0)
    m = frame.measurements
    assert m["gain"] == pytest.approx(expect_gain, abs=0.35)
    if expect_thd_above is not None:
        assert m["ch2"]["thdnPct"] > expect_thd_above


def test_scenario_is_deterministic():
    """Same scenario and sequence must replay identically - a recorded demo
    has to look the same tomorrow."""
    from src.main import adapter

    client.post("/debug/scenario", json={"scenario": "gain_error"}, headers=auth(pair()))
    a = adapter.read_scope_frame(7)
    b = adapter.read_scope_frame(7)
    assert a.ch1.tolist() == b.ch1.tolist()
    assert a.ch2.tolist() == b.ch2.tolist()


# -- websocket ---------------------------------------------------------


def test_ws_requires_token():
    with pytest.raises(Exception):
        with client.websocket_connect("/ws") as ws:
            ws.receive_text()


def test_ws_streams_after_pairing():
    token = pair()
    with client.websocket_connect(f"/ws?token={token}") as ws:
        kinds = set()
        for _ in range(4):
            import json

            msg = json.loads(ws.receive_text())
            kinds.add(msg["type"])
            if {"waveform", "measurements"} <= kinds:
                break
        assert {"waveform", "measurements"} <= kinds


# -- real adapter (experimental) ---------------------------------------


def test_real_adapter_reports_unverified():
    """真实硬件路径必须自己承认未验证 —— UI 的警示横幅全靠这两个字段。

    这里不需要 libm2k：没装时走 LIBM2K_MISSING 分支，同样必须带标记。
    """
    from src.adapters.real_m2k import RealM2kAdapter

    s = RealM2kAdapter().status()
    assert s.hardware_verified is False
    assert s.experimental is True
    assert s.mock is False


def test_mock_adapter_is_not_experimental():
    from src.adapters.mock_m2k import MockM2kAdapter

    s = MockM2kAdapter().status()
    assert s.hardware_verified is True
    assert s.experimental is False


def test_real_adapter_rejects_unknown_waveform():
    """波形名不认识要显式报错，不能静默按正弦推出去。"""
    from src.adapters import AdapterError, AwgConfig
    from src.adapters.real_m2k import RealM2kAdapter

    with pytest.raises(AdapterError) as exc:
        RealM2kAdapter().configure_awg(
            AwgConfig(channel="W1", wave="noise", freq_hz=1000.0, amplitude_vpp=0.4, offset_v=0.0)
        )
    assert exc.value.code == "WAVEFORM_UNSUPPORTED"


def test_real_adapter_rejects_unreachable_frequency_before_touching_device():
    """频率合成不出来要报 FREQ_UNREACHABLE，而不是悄悄输出一个别的频率。

    老实现写死 75MSPS/1024 点，无论请求多少都输出 73.2kHz 且返回 200 ——
    这正是「看起来成功的错误」，比报错危险得多。
    """
    from src.adapters import AdapterError, AwgConfig
    from src.adapters.real_m2k import RealM2kAdapter

    # 25MHz 在硬件上限（30MHz）之内，但 75MSPS 的 DAC 合成不出可用波形
    #（每周期只有 3 个点）。两级拒绝的分工要明确：
    #   > 30MHz  → LIMIT_EXCEEDED（超器件规格，confirm 也绕不过）
    #   18.75~30MHz → FREQ_UNREACHABLE（规格内，但这个采样率合成不了）
    with pytest.raises(AdapterError) as exc:
        RealM2kAdapter().configure_awg(
            AwgConfig(channel="W1", wave="sine", freq_hz=25_000_000.0, amplitude_vpp=0.4)
        )
    # 频率判定在设备检查之前：没插设备时也该说「这个频率做不到」
    assert exc.value.code == "FREQ_UNREACHABLE"
    assert "可达范围" in str(exc.value)


def test_hardware_limit_takes_precedence_over_synthesis():
    """超器件绝对规格时报 LIMIT_EXCEEDED，不是 FREQ_UNREACHABLE。

    两者的处理完全不同：前者换个采样率也没用，后者换个频率就行。
    """
    from src.adapters import AdapterError, AwgConfig
    from src.adapters.real_m2k import RealM2kAdapter

    with pytest.raises(AdapterError) as exc:
        RealM2kAdapter().configure_awg(
            AwgConfig(channel="W1", wave="sine", freq_hz=50_000_000.0, amplitude_vpp=0.4)
        )
    assert exc.value.code == "LIMIT_EXCEEDED"


def test_supported_waveforms_pass_planning_and_fail_only_on_no_device():
    """五种波形都要能过规划阶段，最后卡在「没插设备」而不是「不支持」。

    这一条是同事拿到硬件前唯一能验的：波形与频率的逻辑都对了，
    只差真机。
    """
    from src.adapters import AdapterError, AwgConfig
    from src.adapters.real_m2k import RealM2kAdapter

    for wave in ("sine", "square", "triangle", "sawtooth", "dc"):
        with pytest.raises(AdapterError) as exc:
            RealM2kAdapter().configure_awg(
                AwgConfig(channel="W1", wave=wave, freq_hz=1000.0, amplitude_vpp=0.4)
            )
        assert exc.value.code in ("NO_DEVICE", "LIBM2K_MISSING"), f"{wave} 卡在了 {exc.value.code}"


def test_real_adapter_enumeration_names_the_real_cause():
    """没装 libm2k 时枚举设备要说「库没装」，不能报「没有设备」。

    返回空列表会让人去查 USB 线和 Scopy 占用，方向完全错了。
    """
    from src.adapters import AdapterError
    from src.adapters.real_m2k import RealM2kAdapter

    with pytest.raises(AdapterError) as exc:
        RealM2kAdapter().list_devices()
    assert exc.value.code == "LIBM2K_MISSING"
    assert "libm2k" in str(exc.value)


# -- 真机联调用的两个端点 ----------------------------------------------


def test_measure_once_requires_pairing():
    """一次性采集也是控制面：它会触发真实采集。"""
    assert client.post("/scope/measure").status_code == 401


def test_measure_once_returns_numbers_not_waveform():
    """返回测量值而不是波形数组 —— 回答「通了没有」不需要几十 KB 的点。"""
    token = pair()
    res = client.post("/scope/measure", json={"samples": 2048}, headers=auth(token))
    assert res.status_code == 200
    body = res.json()
    assert "measurements" in body and "sampleRate" in body
    # 不该把原始波形塞进来
    assert "ch1" not in body
    m = body["measurements"]
    assert {"ch1", "ch2", "gain", "phaseDeg"} <= m.keys()


def test_diagnostics_requires_pairing():
    assert client.get("/diagnostics").status_code == 401


def test_diagnostics_works_on_mock_without_crashing():
    """mock 没有诊断信息，但端点不能报错 —— 同事可能先在 mock 上试一遍。"""
    res = client.get("/diagnostics", headers=auth(pair()))
    assert res.status_code == 200
    assert res.json()["adapter"] == "mock"


def test_phase_is_computed_not_hardcoded():
    """相位必须从波形算，不能是常量。

    原来写死 176.8：对 mock 恰好正确（合成波形里带着 3.2° 滞后），
    但接上真实硬件后会永远显示 176.8，无论实际相位是多少。
    """
    import numpy as np

    from src.scenarios import measure

    fs = 1_000_000.0
    t = np.arange(2048) / fs
    ref = np.sin(2 * np.pi * 1000 * t)

    def wrap(d: float) -> float:
        return (d + 180.0) % 360.0 - 180.0

    for shift_deg in (0.0, 45.0, 90.0, -90.0, 135.0, 180.0):
        shifted = np.sin(2 * np.pi * 1000 * t + np.deg2rad(shift_deg))
        got = measure(ref, shifted, fs)["phaseDeg"]
        # ±180 是同一个角度，比较时也要绕回
        assert wrap(got - shift_deg) == pytest.approx(0.0, abs=1.0), f"{shift_deg}° 算成了 {got}°"


def test_phase_deviation_wraps_around_180():
    """相对 180° 的偏差要绕回，不能直接相减。

    实测 -179°（等价 181°）直接减 180 会得到 -359°。mock 的相位恒在 176.8
    附近所以看不出来，真实硬件上相位稍过 180° 就会出现。
    """
    import numpy as np

    from src.scenarios import measure

    fs = 1_000_000.0
    t = np.arange(2048) / fs
    ref = np.sin(2 * np.pi * 1000 * t)

    for shift_deg, want_dev in ((176.8, -3.2), (183.0, 3.0), (180.0, 0.0)):
        shifted = np.sin(2 * np.pi * 1000 * t + np.deg2rad(shift_deg))
        dev = measure(ref, shifted, fs)["phaseDeviationDeg"]
        assert dev == pytest.approx(want_dev, abs=1.0), f"{shift_deg}° 的偏差算成了 {dev}°"


def test_phase_is_zero_when_ch2_has_no_signal():
    """CH2 没信号时报 0，不报噪声的相位。"""
    import numpy as np

    from src.scenarios import measure

    fs = 1_000_000.0
    t = np.arange(2048) / fs
    ref = np.sin(2 * np.pi * 1000 * t)
    flat = np.full(2048, 0.01)
    assert measure(ref, flat, fs)["phaseDeg"] == 0.0


@pytest.mark.parametrize("n", [512, 2048, 4096, 16384])
def test_measure_honours_requested_samples(n):
    """两个 adapter 的签名统一之后，请求多少点就该采多少点。

    以前 main.py 靠 inspect 判断 adapter 支不支持 samples，mock 那条路
    直接忽略请求值 —— 调用方会以为自己拿到了 4096 点的频率分辨率。
    """
    res = client.post("/scope/measure", json={"samples": n}, headers=auth(pair()))
    body = res.json()
    assert body["requestedSamples"] == n
    assert body["samples"] == n


def test_measure_reports_requested_and_actual_separately():
    """两个字段都要在。相等是正常情况，不相等说明 adapter 没按请求采 ——
    那正是需要被看见的。"""
    body = client.post("/scope/measure", json={"samples": 1024}, headers=auth(pair())).json()
    assert {"samples", "requestedSamples"} <= body.keys()


def test_measure_rejects_out_of_range_samples():
    """点数有上下界：太少算不出频率，太多一次采集会卡住。"""
    token = pair()
    for n in (32, 131072):
        res = client.post("/scope/measure", json={"samples": n}, headers=auth(token))
        assert res.status_code == 422, f"samples={n} 应被拒绝"


def test_websocket_stream_still_uses_default_samples():
    """WS 流不传 samples，走默认值 —— 统一签名不能把流打断。

    帧里的点数是 DEFAULT_SAMPLES / DISPLAY_STRIDE：波形是给屏幕看的，
    2048 点抽到 512 已经超过一般画布的水平像素数，全量传只是浪费带宽。
    要全分辨率的数据走 /scope/measure。
    """
    import json

    from src.adapters.base import DEFAULT_SAMPLES
    from src.protocol import DISPLAY_STRIDE

    token = pair()
    with client.websocket_connect(f"/ws?token={token}") as ws:
        for _ in range(4):
            msg = json.loads(ws.receive_text())
            if msg["type"] == "waveform":
                assert len(msg["ch1"]) == DEFAULT_SAMPLES // DISPLAY_STRIDE
                return
    raise AssertionError("没有收到 waveform 帧")


def test_all_adapters_share_the_same_signature():
    """base / mock / real 三处签名必须一致。

    不一致的话 main.py 就得靠 inspect 去猜，而猜错的表现是「请求被静默忽略」。
    """
    import inspect

    from src.adapters.base import DEFAULT_SAMPLES
    from src.adapters.mock_m2k import MockM2kAdapter
    from src.adapters.real_m2k import RealM2kAdapter

    for cls in (MockM2kAdapter, RealM2kAdapter):
        sig = inspect.signature(cls.read_scope_frame)
        assert list(sig.parameters) == ["self", "sequence", "samples"], cls.__name__
        assert sig.parameters["samples"].default == DEFAULT_SAMPLES, cls.__name__


def test_dominant_freq_never_reports_zero_for_a_live_signal():
    """采样窗口不足一个周期时，主频不能报成 0Hz。

    减完均值后 bin 0 本该是 0，但窗口太短时残留直流会让它成为最大值 ——
    结果是有信号的通道被报成 0Hz，看起来像通道断了。
    """
    import numpy as np

    from src.scenarios import measure

    fs = 1_000_000.0
    for n in (256, 512, 1024, 2048):
        t = np.arange(n) / fs
        sig = 0.2 * np.sin(2 * np.pi * 1000 * t)
        m = measure(sig, sig, fs)["ch1"]
        assert m["freqHz"] > 0.0, f"{n} 点时报了 {m['freqHz']}Hz"


def test_measurements_report_frequency_resolution():
    """频率分辨率要报出来：测到的频率和它同量级时读数不可信。"""
    import numpy as np

    from src.scenarios import measure

    fs = 1_000_000.0
    t = np.arange(512) / fs
    sig = 0.2 * np.sin(2 * np.pi * 1000 * t)
    m = measure(sig, sig, fs)["ch1"]
    # 512 点 @1MSPS → 分辨率约 1953Hz，比要测的 1kHz 还大
    assert m["freqResolutionHz"] == pytest.approx(fs / 512, rel=0.01)
    assert m["freqResolutionHz"] > 1000.0

    t = np.arange(8192) / fs
    sig = 0.2 * np.sin(2 * np.pi * 1000 * t)
    m = measure(sig, sig, fs)["ch1"]
    assert m["freqResolutionHz"] < 200.0
    assert m["freqHz"] == pytest.approx(1000.0, rel=0.05)


def test_mock_awg_returns_same_shape_as_real():
    """两个 adapter 的 configure_awg 返回同一形状。

    形状不一致的话，hardware_smoke 这类工具就得为每个 adapter 写分支，
    而分支写漏的表现是「mock 上看着好好的，真机上少了几个字段」。
    """
    from src.adapters import AwgConfig
    from src.adapters.mock_m2k import MockM2kAdapter

    got = MockM2kAdapter().configure_awg(AwgConfig(wave="sine", freq_hz=1000.0))
    for key in ("applied", "channel", "wave", "amplitudeVpp", "offsetV",
                "requestedFreqHz", "actualFreqHz", "freqErrorPct"):
        assert key in got, f"缺字段 {key}"


def test_mock_awg_does_not_lie_about_frequency():
    """形状一致 ≠ 内容可以造假。

    mock 是场景回放，波形固定 1kHz。请求 5kHz 时如实报 1000 与 400% 误差，
    而不是把请求值抄回去 —— 那样 mock 上永远「频率正确」，真机上才发现不对。
    """
    from src.adapters import AwgConfig
    from src.adapters.mock_m2k import MockM2kAdapter

    a = MockM2kAdapter()
    at_1k = a.configure_awg(AwgConfig(wave="sine", freq_hz=1000.0))
    assert at_1k["actualFreqHz"] == 1000.0
    assert at_1k["freqErrorPct"] == 0.0

    at_5k = a.configure_awg(AwgConfig(wave="sine", freq_hz=5000.0))
    assert at_5k["actualFreqHz"] == 1000.0
    # 误差相对请求值算：|1000-5000|/5000 = 80%
    assert at_5k["freqErrorPct"] == pytest.approx(80.0)
    assert at_5k["simulated"] is True


def test_mock_awg_rejects_unknown_waveform_like_real():
    from src.adapters import AdapterError, AwgConfig
    from src.adapters.mock_m2k import MockM2kAdapter

    with pytest.raises(AdapterError) as exc:
        MockM2kAdapter().configure_awg(AwgConfig(wave="noise"))
    assert exc.value.code == "WAVEFORM_UNSUPPORTED"


@pytest.mark.parametrize("freq,code", [(25_000_000.0, "FREQ_UNREACHABLE"), (50_000_000.0, "LIMIT_EXCEEDED")])
def test_both_adapters_reject_the_same_frequencies(freq, code):
    """两个 adapter 的拒绝行为必须一致。

    mock 上能配成、真机上配不成的话，人会在 mock 上试通之后接硬件，
    然后把「频率做不到」误判成硬件问题。
    """
    from src.adapters import AdapterError, AwgConfig
    from src.adapters.mock_m2k import MockM2kAdapter
    from src.adapters.real_m2k import RealM2kAdapter

    for adapter in (MockM2kAdapter(), RealM2kAdapter()):
        with pytest.raises(AdapterError) as exc:
            adapter.configure_awg(AwgConfig(wave="sine", freq_hz=freq, amplitude_vpp=0.4))
        assert exc.value.code == code, f"{type(adapter).__name__} 报了 {exc.value.code}"


def test_demo_frequencies_still_accepted_by_mock():
    """内置 Demo 用的频率不能被新校验挡掉 —— 回归底线。"""
    from src.adapters import AwgConfig
    from src.adapters.mock_m2k import MockM2kAdapter

    a = MockM2kAdapter()
    for freq in (1000.0, 10_000.0):
        assert a.configure_awg(AwgConfig(wave="sine", freq_hz=freq))["applied"] is True
    assert a.configure_awg(AwgConfig(wave="dc", freq_hz=0.0, offset_v=2.5))["applied"] is True


# -- 从另一份独立实现吸收的硬件层改动 ---------------------------------


def test_try_variants_records_which_signature_worked():
    """同一功能的多种签名依次试，并记下哪个成了。

    setCyclic 在我们的实现里是 setCyclic(True)，另一份独立实现是
    setCyclic(idx, True)。两份都没在真机上跑过，所以不是拿一个猜测替换
    另一个 —— 都试一遍，把生效的签名记进 notes 供 docs/10 §1.5.1 回填。
    """
    from src.adapters.real_m2k import RealM2kAdapter

    a = RealM2kAdapter()
    calls: list[str] = []

    def fail():
        calls.append("first")
        raise TypeError("takes 2 positional arguments but 3 were given")

    def ok():
        calls.append("second")

    sig = a._try_variants("test", [("A(x, y)", fail), ("A(y)", ok)])
    assert sig == "A(y)"
    assert calls == ["first", "second"]
    assert any("用 A(y)" in n for n in a._notes)


def test_try_variants_reports_all_failures():
    """全都失败时要把每个签名的报错都列出来，不是笼统一句「失败」。"""
    from src.adapters.real_m2k import RealM2kAdapter

    a = RealM2kAdapter()

    def boom():
        raise AttributeError("no such method")

    assert a._try_variants("test", [("A()", boom), ("B()", boom)]) is None
    note = next(n for n in a._notes if "test" in n)
    assert "A()" in note and "B()" in note


def test_discard_next_is_armed_after_scope_reconfigure():
    """换量程之后要丢一个 buffer。

    不丢的话每次调量程都会看到一个假尖峰，而它看起来完全像是被测电路
    上的毛刺 —— 这种「像真的一样的假象」最费排查时间。
    """
    from src.adapters.real_m2k import RealM2kAdapter

    a = RealM2kAdapter()
    # 连接前就该是 True：第一次采集也要丢
    assert a._discard_next is True


def test_emergency_stop_survives_without_device():
    """没连设备时急停也不能抛 —— 急停必须任何时候都能按。"""
    from src.adapters.real_m2k import RealM2kAdapter

    a = RealM2kAdapter()
    a.emergency_stop()
    assert a._running is False
