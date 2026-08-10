import os
import sys
import tempfile
from pathlib import Path

# Point the bridge at a throwaway config so tests never touch the developer's
# real paired token in ~/.board-debug-copilot.
_tmp = tempfile.mkdtemp(prefix="bdc-bridge-test-")
os.environ["BRIDGE_CONFIG"] = str(Path(_tmp) / "bridge.json")
os.environ.setdefault("BRIDGE_MOCK", "true")
os.environ.setdefault("BRIDGE_REQUIRE_PAIRING", "true")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
