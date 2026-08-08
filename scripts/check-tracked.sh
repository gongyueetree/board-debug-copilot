#!/usr/bin/env bash
# 检查是否有源码文件被 .gitignore 误伤。
#
# 起因：.gitignore 里给 mock 对象存储写的 storage/ 规则，
# 把 apps/api/src/storage/ 也一起忽略了。本地构建通过、Railway 构建失败，
# 因为文件根本没进仓库。这类问题不该等到部署才暴露。
set -e
cd "$(dirname "$0")/.."

missed=$(git ls-files --others --ignored --exclude-standard \
  | grep -E '^(apps|packages|scripts)/.*\.(ts|tsx|py|prisma)$' \
  | grep -v node_modules \
  | grep -v '/dist/' \
  | grep -v '\.next/' || true)

if [ -n "$missed" ]; then
  echo "以下源码文件被 .gitignore 忽略了，很可能是规则写得太宽："
  echo "$missed" | sed 's/^/  /'
  echo
  echo "用 git check-ignore -v <文件> 查是哪条规则命中的。"
  exit 1
fi

echo "✓ 无源码文件被误忽略"
