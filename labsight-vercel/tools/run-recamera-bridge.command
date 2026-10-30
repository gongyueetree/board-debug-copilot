#!/bin/zsh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/camera-python-env.sh"
labsight_setup_python "$SCRIPT_DIR/../.venv-recamera" "$SCRIPT_DIR/requirements-recamera-bridge.txt"
exec "$PY" "$SCRIPT_DIR/recamera_webrtc_bridge.py" --host 127.0.0.1 --port 18765
