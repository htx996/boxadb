#!/usr/bin/env bash
# 把官方 Node 二进制（gzip 后）放进 embedded/，供桌面版构建时 go:embed 打进 exe。
# 用法: scripts/fetch-node.sh [goos-goarch]   （默认当前机器；CI 按矩阵传入，如 windows-amd64）
# 校验：版本与各平台 sha256 钉死在 scripts/node-checksums.json（来自 nodejs.org 官方 SHASUMS256.txt）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF="$ROOT/scripts/node-checksums.json"
if [ $# -ge 1 ]; then
  GOOS_GOARCH="$1"
elif command -v go >/dev/null 2>&1; then
  GOOS_GOARCH="$(go env GOOS)-$(go env GOARCH)"
else
  echo "用法: $0 <goos-goarch>（如 darwin-arm64 / windows-amd64），未装 go 时须显式指定" >&2
  exit 2
fi

want() { sed -n 's/.*"'"$1"'":[[:space:]]*"\([0-9a-f]*\)".*/\1/p' "$CONF" | head -1; }
NODE_VER="$(sed -n 's/.*"version":[[:space:]]*"\([0-9.]*\)".*/\1/p' "$CONF" | head -1)"
NODE_SHA="$(want "$GOOS_GOARCH")"
[ -n "$NODE_VER" ] && [ -n "$NODE_SHA" ] || { echo "node-checksums.json 缺少平台 $GOOS_GOARCH" >&2; exit 1; }

# goos-goarch → nodejs.org 发行包命名
case "$GOOS_GOARCH" in
  darwin-amd64) DIST="darwin-x64"; EXT="tar.xz"; BIN="bin/node" ;;
  darwin-arm64) DIST="darwin-arm64"; EXT="tar.xz"; BIN="bin/node" ;;
  linux-amd64)  DIST="linux-x64";  EXT="tar.xz"; BIN="bin/node" ;;
  linux-arm64)  DIST="linux-arm64"; EXT="tar.xz"; BIN="bin/node" ;;
  windows-amd64) DIST="win-x64";   EXT="zip";    BIN="node.exe" ;;
  *) echo "不支持的平台: $GOOS_GOARCH" >&2; exit 1 ;;
esac

TAG="node-v$NODE_VER-$DIST"
OUT_DIR="$ROOT/embedded"
OUT="$OUT_DIR/node-$GOOS_GOARCH.gz"
VER_FILE="$OUT_DIR/node-$GOOS_GOARCH.version"
CACHE_DIR="${HOME}/.cache/boxadb-fetch-node"
mkdir -p "$OUT_DIR" "$CACHE_DIR"

# 已是当前钉死版本就跳过（CI 缓存 / 本地重复构建友好）
if [ -f "$VER_FILE" ] && [ "$(cat "$VER_FILE")" = "$NODE_SHA" ]; then
  echo "embedded/node-$GOOS_GOARCH.gz 已是 v$NODE_VER，跳过"
  exit 0
fi

ARCHIVE="$CACHE_DIR/$TAG.$EXT"
if [ ! -f "$ARCHIVE" ]; then
  echo "下载 https://nodejs.org/dist/v$NODE_VER/$TAG.$EXT ..."
  curl -fL --retry 3 -o "$ARCHIVE" "https://nodejs.org/dist/v$NODE_VER/$TAG.$EXT"
fi
if command -v shasum >/dev/null 2>&1; then
  echo "${NODE_SHA}  ${ARCHIVE}" | ( cd / && shasum -a 256 -c - ) || {
    echo "sha256 校验失败（官方源与钉死值不符？），中止且不会污染 embedded/" >&2
    rm -f "$ARCHIVE"; exit 1; }
else
  echo "${NODE_SHA}  ${ARCHIVE}" | sha256sum -c - || {
    echo "sha256 校验失败（官方源与钉死值不符？），中止且不会污染 embedded/" >&2
    rm -f "$ARCHIVE"; exit 1; }
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
case "$EXT" in
  tar.xz) tar -xJf "$ARCHIVE" -C "$WORK" "$TAG/$BIN" ;;
  zip)    unzip -oqq "$ARCHIVE" -d "$WORK" "$TAG/$BIN" ;;
esac

gzip -9 -n -c "$WORK/$TAG/$BIN" > "$OUT.tmp"
mv "$OUT.tmp" "$OUT"
printf '%s' "$NODE_SHA" > "$VER_FILE"
echo "已生成 $OUT（$(du -h "$OUT" | cut -f1)，来源 v$NODE_VER/$DIST）"
