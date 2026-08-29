#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$HOME/.labsight/recamera-webrtc-venv"
LOG_DIR="$HOME/Library/Logs/LabSight"
PLIST="$HOME/Library/LaunchAgents/cn.eetree.labsight.recamera.plist"
LABEL="cn.eetree.labsight.recamera"
PY="$VENV_DIR/bin/python"

mkdir -p "$HOME/.labsight" "$LOG_DIR" "$HOME/Library/LaunchAgents"

if [[ ! -x "$PY" ]]; then
  echo "[LabSight] 创建 Python 环境…"
  python3 -m venv "$VENV_DIR"
fi

echo "[LabSight] 安装/更新 reCamera WebRTC 依赖…"
"$VENV_DIR/bin/pip" install --upgrade pip >/dev/null
"$VENV_DIR/bin/pip" install -r "$SCRIPT_DIR/requirements-recamera-bridge.txt"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string>
    <string>$SCRIPT_DIR/recamera_webrtc_bridge.py</string>
    <string>--host</string><string>127.0.0.1</string>
    <string>--port</string><string>18765</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOG_DIR/recamera-webrtc.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/recamera-webrtc-error.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

for i in {1..30}; do
  if curl -fsS http://127.0.0.1:18765/health >/dev/null 2>&1; then
    echo ""
    echo "✅ LabSight reCamera WebRTC 后台服务已安装并启动。"
    echo "以后登录 Mac 会自动运行，不需要再启动 Python。"
    echo "健康检查：http://127.0.0.1:18765/health"
    echo ""
    read "?按回车关闭…"
    exit 0
  fi
  sleep 0.4
done

echo ""
echo "⚠️ 服务已安装，但健康检查暂未通过。"
echo "查看日志：$LOG_DIR/recamera-webrtc-error.log"
read "?按回车关闭…"
