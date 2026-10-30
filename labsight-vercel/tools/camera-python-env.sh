# Shared by the macOS launchers (bash/zsh compatible). No system Python changes.
# Call: labsight_setup_python VENV_PREFIX REQUIREMENTS_FILE
labsight_setup_python() {
  local prefix="$1" requirements="$2" candidate version chosen="" selected=""
  if [ -n "${LABSIGHT_PYTHON:-}" ]; then
    chosen="$LABSIGHT_PYTHON"
    selected="$("$chosen" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null)" || selected=""
    case "$selected" in 3.11|3.12) ;; *)
      echo "LABSIGHT_PYTHON 必须指向 Python 3.11 或 3.12。" >&2
      return 1 ;;
    esac
  else
    for candidate in python3.12 /opt/homebrew/bin/python3.12 /usr/local/bin/python3.12 /Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12 python3.11 /opt/homebrew/bin/python3.11 /usr/local/bin/python3.11 python3; do
      version="$("$candidate" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null)" || continue
      case "$version" in 3.11|3.12) chosen="$candidate"; selected="$version"; break ;; esac
    done
  fi
  if [ -z "$chosen" ]; then
    echo "[LabSight] 未找到 Python 3.11/3.12。请先执行 brew install python@3.12，或从 python.org 安装 Python 3.12 的 macOS 安装包，然后重试。" >&2
    return 1
  fi
  # Never reuse the old .venv-recamera, which may have an incompatible Python.
  VENV_DIR="${prefix}-py${selected}"
  PY="$VENV_DIR/bin/python"
  if [ -e "$VENV_DIR" ]; then
    version="$("$PY" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null)" || version=""
    if [ "$version" != "$selected" ]; then
      echo "[LabSight] $VENV_DIR 已存在但 Python 不匹配或环境损坏。请重命名此目录后重试；脚本不会删除它。" >&2
      return 1
    fi
  else
    "$chosen" -m venv "$VENV_DIR" || return 1
  fi
  echo "[LabSight] 使用 Python $selected：$PY"
  "$PY" -m pip install --upgrade --only-binary=:all: pip || return 1
  if ! "$PY" -m pip install --only-binary=:all: -r "$requirements"; then
    echo "[LabSight] 未能安装预编译依赖，已停止；不会编译 PyAV。请检查网络、pip 镜像、macOS 版本和 Python 架构。" >&2
    "$PY" -c 'import sys, platform; print(sys.version); print(platform.platform()); print(platform.machine())'
    return 1
  fi
  "$PY" -c 'import av, aiortc, aiohttp; print("[LabSight] 视频依赖已就绪，PyAV", av.__version__)' || return 1
}
