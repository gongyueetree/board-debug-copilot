#!/bin/zsh
set -e
cd "$(dirname "$0")/.."
VENV=".venv-recamera"
if [ ! -d "$VENV" ]; then
  python3 -m venv "$VENV"
fi
source "$VENV/bin/activate"
python -m pip install --upgrade pip
python -m pip install -r tools/requirements-recamera-bridge.txt
exec python tools/recamera_webrtc_bridge.py --host 127.0.0.1 --port 18765
