"""Local pairing.

Origin checking alone is not enough: any local process can send requests
without an Origin header at all. Pairing proves the caller had access to the
screen where the bridge printed its code, which is the property we actually
want for a device that can drive real hardware.

The token is persisted so a bridge restart does not force the user to re-pair.
"""

from __future__ import annotations

import json
import os
import secrets
import time
from dataclasses import dataclass
from pathlib import Path

PAIRING_TTL_SECONDS = 300
TOKEN_TTL_SECONDS = 30 * 24 * 3600


def config_path() -> Path:
    override = os.getenv("BRIDGE_CONFIG")
    if override:
        return Path(override)
    base = Path(os.path.expanduser("~")) / ".board-debug-copilot"
    return base / "bridge.json"


@dataclass
class PairingState:
    code: str | None = None
    code_expires_at: float = 0.0
    tokens: dict[str, float] | None = None  # token -> expiry

    def __post_init__(self) -> None:
        if self.tokens is None:
            self.tokens = {}


class PairingManager:
    def __init__(self) -> None:
        self._state = PairingState()
        self._load()

    # -- persistence -----------------------------------------------------

    def _load(self) -> None:
        try:
            raw = json.loads(config_path().read_text())
            tokens = {k: float(v) for k, v in (raw.get("tokens") or {}).items()}
            now = time.time()
            self._state.tokens = {k: v for k, v in tokens.items() if v > now}
        except Exception:
            self._state.tokens = {}

    def _save(self) -> None:
        try:
            p = config_path()
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(json.dumps({"tokens": self._state.tokens}, indent=2))
            # Token file is a credential; do not leave it group/world readable.
            os.chmod(p, 0o600)
        except Exception:
            pass

    # -- pairing flow ----------------------------------------------------

    def start(self) -> dict:
        """Generate a 6-digit code, valid for 5 minutes."""
        code = f"{secrets.randbelow(1_000_000):06d}"
        self._state.code = code
        self._state.code_expires_at = time.time() + PAIRING_TTL_SECONDS
        # Printed to the console the user launched the bridge from - that is
        # the out-of-band channel that makes pairing meaningful.
        print("\n" + "=" * 46)
        print(f"  配对码: {code}")
        print(f"  有效期 {PAIRING_TTL_SECONDS // 60} 分钟，在网页里输入即可连接")
        print("=" * 46 + "\n", flush=True)
        return {"expiresInSeconds": PAIRING_TTL_SECONDS}

    def verify(self, code: str) -> str:
        if not self._state.code or time.time() > self._state.code_expires_at:
            raise PermissionError("配对码不存在或已过期，请重新发起配对")
        # Constant-time compare so a wrong code cannot be found by timing.
        if not secrets.compare_digest(code, self._state.code):
            raise PermissionError("配对码错误")

        token = secrets.token_urlsafe(32)
        assert self._state.tokens is not None
        self._state.tokens[token] = time.time() + TOKEN_TTL_SECONDS
        self._state.code = None
        self._save()
        return token

    def revoke(self, token: str | None = None) -> int:
        assert self._state.tokens is not None
        if token is None:
            n = len(self._state.tokens)
            self._state.tokens = {}
        else:
            n = 1 if self._state.tokens.pop(token, None) else 0
        self._save()
        return n

    def is_valid(self, token: str | None) -> bool:
        if not token or self._state.tokens is None:
            return False
        expiry = self._state.tokens.get(token)
        if expiry is None:
            return False
        if expiry < time.time():
            self._state.tokens.pop(token, None)
            self._save()
            return False
        return True

    def status(self) -> dict:
        assert self._state.tokens is not None
        pending = bool(self._state.code) and time.time() <= self._state.code_expires_at
        return {
            "paired": len(self._state.tokens) > 0,
            "activeTokens": len(self._state.tokens),
            "pairingPending": pending,
            "codeExpiresInSeconds": (
                max(0, int(self._state.code_expires_at - time.time())) if pending else 0
            ),
        }
