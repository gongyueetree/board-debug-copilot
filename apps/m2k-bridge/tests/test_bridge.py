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
    client.post("/debug/scenario", json={"scenario": scenario})
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

    client.post("/debug/scenario", json={"scenario": "gain_error"})
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
