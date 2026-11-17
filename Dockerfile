# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────
# 盒子助手 BoxADB · NAS/Docker 版
# 同一个进程既发网页又当 ADB 桥：网页与桥同源，局域网任何设备打开即用。
#
# 构建（本目录）：
#   docker build -t boxadb:latest .
# 运行（NAS 上必须 host 网络，理由见 docker-compose.yml）：
#   docker run -d --name boxadb --restart unless-stopped --network host boxadb:latest
# 然后打开 http://<NAS 的 IP>:8765/
# ─────────────────────────────────────────────────────────────

# ── 构建阶段 ──
FROM golang:1.21-alpine AS build
WORKDIR /src

# 无第三方依赖（纯标准库 + 自实现 RFC 6455 WS 帧），
# 不需要 go.sum。
COPY go.mod ./
COPY bridge.go tls.go webapp_on.go webapp_off.go ./

# webapp/ 只在本阶段生成，宿主机副本已被 .dockerignore 排除，
# 避免镜像里嵌进陈旧前端。
COPY scripts/make-webapp.sh ./scripts/
COPY index.html ./
COPY css ./css
COPY js ./js
COPY assets/logo.png ./assets/logo.png

# 刻意不 apk add：脚本用 POSIX sh + coreutils，Alpine 源境内常拉不动。
RUN sh scripts/make-webapp.sh

ENV CGO_ENABLED=0
RUN go build -trimpath -tags withwebapp -ldflags="-s -w" -o /out/boxadb-bridge .

# Docker 不能 COPY 空目录，故在此阶段建 /out/data 并留占位文件
# （运行阶段无 shell，建目录只能放在这里）
RUN mkdir -p /out/data && touch /out/data/.keep

# ── 运行阶段：无 shell、无 CA、无语言运行时，只有一个静态二进制 ──
FROM scratch
LABEL org.opencontainers.image.title="BoxADB" \
      org.opencontainers.image.description="盒子助手：网页版 ADB 工具箱（电视盒子 / Android TV），网页与桥同源" \
      org.opencontainers.image.source="https://github.com/wukongdaily/boxadb" \
      org.opencontainers.image.licenses="MIT"

COPY --from=build /out/boxadb-bridge /boxadb-bridge

# 容器必须对外监听；桌面版仍默认 127.0.0.1
# BRIDGE_PRIVATE_ONLY=1：隧道只允许私网地址（防 SSRF）
# 内置 https：自签证书 SAN 覆盖本机地址，手机需要安全上下文
ENV BRIDGE_HOST=0.0.0.0 \
    BRIDGE_PORT=8765 \
    BRIDGE_HTTPS_PORT=8766 \
    BRIDGE_PRIVATE_ONLY=1 \
    BRIDGE_STATE_DIR=/data

EXPOSE 8765 8766

# /data 存自签证书：挂卷则重启不换证书
COPY --from=build --chown=65534:65534 /out/data /data
VOLUME /data

USER 65534:65534

# scratch 里没有 curl/sh，健康检查直接用本程序自带的 -healthcheck 子命令
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["/boxadb-bridge", "-healthcheck"]

ENTRYPOINT ["/boxadb-bridge"]
