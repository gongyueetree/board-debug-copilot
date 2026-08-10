#!/usr/bin/env bash
# 检查是否有源码文件被 .gitignore 误伤。
#
# 起因：.gitignore 里给 mock 对象存储写的 storage/ 规则，
# 把 apps/api/src/storage/ 也一起忽略了。本地构建通过、Railway 构建失败，
# 因为文件根本没进仓库。这类问题不该等到部署才暴露。
set -e
cd "$(dirname "$0")/.."

# 只看真正的源码路径：apps/*/src、packages/*/src、scripts、prisma
missed=$(git ls-files --others --ignored --exclude-standard \
  | grep -E '\.(ts|tsx|py|prisma)$' \
  | grep -E '^(apps/[^/]+/src/|packages/[^/]+/(src|prisma)/|scripts/)' \
  | grep -vE '(node_modules|/dist/|\.next/|\.venv/|__pycache__)' || true)

if [ -n "$missed" ]; then
  echo "以下源码文件被 .gitignore 忽略了，很可能是规则写得太宽："
  echo "$missed" | sed 's/^/  /'
  echo
  echo "用 git check-ignore -v <文件> 查是哪条规则命中的。"
  exit 1
fi

# 反向检查：构建产物不该出现在 src/ 里，更不该被跟踪
artifacts=$(git ls-files 'packages/*/src/*.js' 'packages/*/src/*.d.ts' 'packages/*/src/*.map' \
  'apps/*/src/*.js' 'apps/*/src/*.d.ts' 2>/dev/null || true)
if [ -n "$artifacts" ]; then
  echo "以下构建产物被提交进了源码目录："
  echo "$artifacts" | sed 's/^/  /'
  echo
  echo "src/ 只放源码，产物应在 dist/。用 git rm --cached 移除。"
  exit 1
fi

# 源码里不该有真实控制字节。
#
# 起因：packages/storage 的文件名 sanitize 正则里嵌了真实的 NUL 与 US 字节，
# 而不是转义序列。语义碰巧一样，但 git 与 grep 把整个文件当二进制 ——
# diff 显示 "Binary file differs"，代码审查等于失明。
binary=$(git ls-files -z '*.ts' '*.tsx' '*.js' '*.mjs' '*.py' '*.json' '*.md' '*.yml' '*.yaml' '*.sh' '*.prisma' '*.css' \
  | python3 -c '
import sys
BAD = set(range(0, 9)) | set(range(14, 32)) | {127}
for path in sys.stdin.buffer.read().split(b"\0"):
    if not path:
        continue
    name = path.decode()
    try:
        data = open(name, "rb").read()
    except OSError:
        continue
    hit = sorted({c for c in data if c in BAD})
    if hit:
        print(f"{name}  控制字节 {hit}")
')
if [ -n "$binary" ]; then
  echo "以下源码文件含真实控制字节，git 会当二进制处理："
  echo "$binary" | sed 's/^/  /'
  echo
  echo "正则/字符串里请写转义序列（\\x00）或 String.fromCharCode，不要嵌真实字节。"
  exit 1
fi

echo "✓ 无源码文件被误忽略，无构建产物混入 src，无控制字节"
