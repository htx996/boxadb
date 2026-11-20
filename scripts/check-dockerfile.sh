#!/bin/sh
# 校验 Dockerfile 构建上下文是否自洽：按其中的 COPY 清单拼一份临时上下文，
# 再跑 make-webapp 与两种构建。
# 防住「新加 .go 忘了写进 COPY」这类只在真构建才炸的错。
#
# 用法（仓库根目录）：sh scripts/check-dockerfile.sh [Dockerfile]
set -eu

cd "$(dirname "$0")/.."
DF=${1:-Dockerfile}
[ -f "$DF" ] || { echo "check-dockerfile: 找不到 $DF" >&2; exit 1; }
command -v go >/dev/null 2>&1 || { echo "check-dockerfile: 需要 go 在 PATH 里" >&2; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP" 2>/dev/null || true' EXIT INT TERM

# 从 Dockerfile 摘出「来自构建上下文」的 COPY（排除 --from= 的跨阶段拷贝）
COPIES=$(awk '
  /^COPY/ && $0 !~ /--from=/ {
    line=$0; sub(/^COPY[ \t]*/, "", line)
    n=split(line, a, /[ \t]+/)
    for (i=1; i<=n; i++) {
      if (a[i] ~ /^--/) continue          # 跳过 --chown 之类
      if (a[i] ~ /^\.\// || a[i] ~ /\/$/) continue   # 跳过目标目录
      print a[i]
    }
  }' "$DF")

[ -n "$COPIES" ] || { echo "check-dockerfile: 没能从 $DF 解析出 COPY 清单" >&2; exit 1; }

echo "=== 按 $DF 的 COPY 清单拼上下文 ==="
missing=0
for src in $COPIES; do
  if [ -e "$src" ]; then
    # Docker 不 COPY 空目录，这里提前拦住
    if [ -d "$src" ] && [ -z "$(ls -A "$src" 2>/dev/null)" ]; then
      echo "  ✗ $src（空目录：Docker 无法 COPY，需放占位文件，例如 .keep）"
      missing=1
      continue
    fi
    mkdir -p "$TMP/$(dirname "$src")"
    cp -R "$src" "$TMP/$src"
    echo "  ✓ $src"
  else
    echo "  ✗ $src（Dockerfile 引用了，但仓库里不存在）"
    missing=1
  fi
done
[ "$missing" = 0 ] || { echo "check-dockerfile: 上下文缺文件" >&2; exit 1; }

# 反向校验：只查「COPY 引用的文件存在」挡不住漏写 COPY —— 少一行 COPY，
# 上下文照样自洽，要到镜像跑起来才暴露（pair 少一行 = 无线调试整体失效）。
echo "=== 反向校验：仓库里必须进镜像的都在这份清单里 ==="
rc=0
for f in *.go; do
  case "$f" in *_test.go) continue ;; esac
  printf '%s\n' "$COPIES" | grep -qx "$f" || { echo "  ✗ $f 未出现在 COPY 清单"; rc=1; }
done
for d in pair js css assets scripts; do
  printf '%s\n' "$COPIES" | grep -qx "$d" || printf '%s\n' "$COPIES" | grep -q "^$d/" || { echo "  ✗ $d 未被 COPY"; rc=1; }
done
[ "$rc" = 0 ] || { echo "check-dockerfile: COPY 清单不完整（上面列出的是缺项）" >&2; exit 1; }
echo "  ✓ 源文件与目录无遗漏"

# 构建标签也从 Dockerfile 取，避免校验与真实构建脱节
TAGS=$(grep -o '\-tags [a-zA-Z0-9_]*' "$DF" | head -1 | awk '{print $2}')
TAGS_ARG=""
[ -n "$TAGS" ] && TAGS_ARG="-tags $TAGS"

cd "$TMP"
echo "=== 在拼出来的上下文里跑 Dockerfile 的构建步骤 ==="
[ -f scripts/make-webapp.sh ] && sh scripts/make-webapp.sh
CGO_ENABLED=0 go build -trimpath $TAGS_ARG -ldflags="-s -w" -o /dev/null .
echo "  ✓ 自托管形态构建通过（$TAGS_ARG）"
# 桌面形态（不带 tag）也必须能过，且不需要 webapp/
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /dev/null . 2>/dev/null || {
  cd - >/dev/null; CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /dev/null .
  echo "  ✓ 桌面形态构建通过（在本仓目录验证）"
}
echo "check-dockerfile: OK —— Dockerfile 上下文自洽"
