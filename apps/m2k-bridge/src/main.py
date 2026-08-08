"""M2K Bridge - local-only ADALM2000 gateway.

Security boundary (CLAUDE.md rule 5): binds 127.0.0.1 only, validates Origin.
The cloud never touches USB; the browser talks to this process directly.

P0 provides /status, /devices and the scenario switch so the top bar can light up.
P4 fills in /awg, /scope and the WebSocket waveform stream (numpy synthesis when
BRIDGE_MOCK=true), with the five scenario values from docs/05 section 11.1.
"""

from __future__ import annotations

import os
from typing import Literal

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

BRIDGE_MOCK = os.getenv("BRIDGE_MOCK", "true").lower() == "true"
ALLOWED_ORIGINS = [
    o.strip()
    for o in os.getenv("BRIDGE_ALLOWED_ORIGINS", "http://localhost:3000").split(",")
    if o.strip()
]

Scenario = Literal["normal", "gain_error", "clipping", "noisy", "no_response"]

app = FastAPI(title="M2K Bridge", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

_state: dict[str, object] = {"scenario": os.getenv("BRIDGE_SCENARIO", "gain_error")}


class Status(BaseModel):
    connected: bool
    device: str | None
    serial: str | None
    firmware: str | None
    mock: bool
    scenario: str


class ScenarioRequest(BaseModel):
    scenario: Scenario


@app.get("/status", response_model=Status)
def status() -> Status:
    if BRIDGE_MOCK:
        return Status(
            connected=True,
            device="ADALM2000",
            serial="104122A8BC2F",
            firmware="0.39",
            mock=True,
            scenario=str(_state["scenario"]),
        )
    return Status(
        connected=False,
        device=None,
        serial=None,
        firmware=None,
        mock=False,
        scenario=str(_state["scenario"]),
    )


@app.get("/devices")
def devices() -> dict[str, object]:
    if BRIDGE_MOCK:
        return {"devices": [{"uri": "mock://m2k", "name": "ADALM2000 (mock)"}]}
    return {"devices": []}


@app.post("/debug/scenario")
def set_scenario(req: ScenarioRequest) -> dict[str, str]:
    """Switch the mock fault scenario. Values are defined in docs/05 section 11.1."""
    _state["scenario"] = req.scenario
    return {"scenario": req.scenario}


def main() -> None:
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=3777)


if __name__ == "__main__":
    main()
