#!/bin/sh
# 离线出包：本机交叉编译 linux 静态二进制，再用 Dockerfile.offline 打镜像。
# NAS 上 build 不需要拉任何基础镜像，境内 Docker Hub 拉不通也能一次成功。
#
# 用法（仓库根目录，需要本机有 Go）：
#   sh scripts/build-prebuilt.sh            # 默认 amd64 + arm64
#   sh scripts/build-prebuilt.sh amd64      # 只出一个架构
set -eu

cd "$(dirname "$0")/.."

command -v go >/dev/null 2>&1 || { echo "找不到 go，请先安装 Go（或设置 PATH）" >&2; exit 1; }

ARCHS=${*:-"amd64 arm64"}

# 先备齐 go:embed 的输入
[ -d webapp ] || sh scripts/make-webapp.sh

# Docker 不能 COPY 空目录，必须留占位文件
mkdir -p dist/data
touch dist/data/.keep
for a in $ARCHS; do
  echo "=== 编译 linux/$a ==="
  CGO_ENABLED=0 GOOS=linux GOARCH="$a" go build -trimpath -tags withwebapp \
    -ldflags "-s -w" -o "dist/boxadb-bridge-linux-$a" .
  ls -lh "dist/boxadb-bridge-linux-$a" | awk '{print "  " $5 "  " $NF}'
done

cat <<EOF

下一步（在有 Docker 的机器上）：
  docker build -f Dockerfile.offline --build-arg ARCH=amd64 -t boxadb:local .
  docker run -d --name boxadb --restart unless-stopped --network host boxadb:local
EOF
