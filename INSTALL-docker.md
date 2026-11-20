# 盒子助手 · NAS / Docker 版部署说明

一句话：**把「网页 + 桥」合成一个常驻内网服务**。手机、平板、任意电脑打开
`https://<NAS的IP>:8766/` 就能管理客厅盒子，不用再在每台电脑上装东西、开桥。

适用：飞牛 fnOS、群晖、威联通、极空间、unRAID、软路由……任何有 Docker 的 Linux 设备。

---

## 1. 取得镜像

**拉现成镜像（推荐）**：两个仓库内容完全一致，境内一般只有 Docker Hub 拉得动。
```bash
docker pull wukongdaily/boxadb:latest
# 或：docker pull ghcr.io/wukongdaily/boxadb:latest
```

改过代码才需要自己构建（下面两种产物都用 `boxadb:latest` 这个本地标签）：

**方式 A（标准多阶段，会在容器里编译）**
```bash
docker build -t boxadb:latest .
```

**方式 B（离线，境内网络推荐）**：先在有 Go 的机器上交叉编译，再打包，构建过程**不拉任何基础镜像**
```bash
sh scripts/build-prebuilt.sh amd64          # ARM NAS 用 arm64，或两个都要就不带参数
docker build -f Dockerfile.offline --build-arg ARCH=amd64 -t boxadb:latest .
```

镜像里是两个东西：一个静态 Go 桥（连网页一起打包，实测 6 MB，无第三方依赖），加上**配对要用的 Node 运行时**
（运行基座是 `node:24-alpine`，只跑这一个 Node 子进程）。所以整镜像本地约 **178 MB**——比纯 Go 大一圈，
换来的是网页里能直接输配对码，不用你在电脑上装 adb。

## 2. 运行

```bash
docker run -d --name boxadb --restart unless-stopped --network host \
  -v boxadb-data:/data boxadb:latest
```

自己构建的才写 `boxadb:latest`；拉现成的请把镜像名换成 `wukongdaily/boxadb:latest`。

或用 `docker-compose.yml`：`docker compose up -d`

- **`--network host` 是刻意的**：Docker 默认桥接会 SNAT，盒子看到的连接来源变成 docker0 网关地址
  （如 172.17.0.1），adb 授权就会被记到那个虚拟 IP 上；再叠上「`tcpip 5555` 同一时刻只容一个 host」，
  就会出现忽好忽坏的 offline/未授权。host 网络让盒子始终看到你真实的局域网 IP。
- **`-v boxadb-data:/data` 也是刻意的**：自签证书存这里。没有这个卷也能跑，但每次重启会换一张证书，
  浏览器要重新点一次「继续访问」。

## 3. 打开网页

| 地址 | 用途 |
|---|---|
| `https://<NAS的IP>:8766/` | ✅ **推荐**，手机/平板/其他电脑都能用 |
| `http://<NAS的IP>:8765/` | 会自动跳转到上面的 https，不用你手动改 |
| `http://localhost:8765/` | 端口转发/本机场景可用（本机地址浏览器天然放行） |

首次访问 https 会提示「连接不是私密连接」→ 点 **高级 → 继续访问**。
**只需一次**，之后长期有效（证书有效期约 2 年，SAN 覆盖本机所有网卡地址与主机名）。

填盒子 IP → 连接；首次按盒子提示允许调试。

> 你的电视/盒子**提供「无线调试」**时（并非所有安卓 11+ 机型都有，多数电视只有 USB 调试），端口每次开关都会变。**配对一次**即可把连接端口固定成 5555，
> 之后重开开关就能连、不用再输码：步骤见 README 的「无线调试配对」。

> 电脑上也可以用端口转发（不想接受证书时）：
> ```bash
> ssh -p 22 <用户名>@<NAS的IP> -L 8765:127.0.0.1:8765
> ```
> 然后开 `http://localhost:8765/`。

## 4. 为什么必须有 https（原理，一分钟）

浏览器规定：**只有「安全上下文」才开放 WebCrypto**，而 ADB 认证要用它生成 RSA 密钥。
安全上下文 = `https://…` 或 `http://localhost|127.0.0.1`。
`http://192.168.x.x:8765` 两者都不是 → 页面能打开，但生成不了密钥、连不上盒子。
这不是程序 bug，任何网页版 ADB 工具都绕不过去；本项目的解法就是**服务自带自签 https**。

## 5. 配置项（环境变量）

| 变量 | 默认（容器） | 说明 |
|---|---|---|
| `BRIDGE_HOST` | `0.0.0.0` | 监听地址；桌面版默认 `127.0.0.1` |
| `BRIDGE_PORT` | `8765` | http 端口（网页 + 桥） |
| `BRIDGE_HTTPS_PORT` | `8766` | 内置自签 https；设 `0` 关闭（关闭后手机不可用，也不会发生跳转） |
| `BRIDGE_PRIVATE_ONLY` | `1` | 隧道只允许打到私网/VPN 地址，防被当通用内网代理。要连公网地址才设 `0` |
| `BRIDGE_STATE_DIR` | `/data` | 证书落盘目录；留空则每次启动内存生成 |
| `BRIDGE_TLS_HOSTS` | 空 | 额外证书 SAN（逗号分隔），例如你有固定域名或第二个 IP |
| `BRIDGE_BASE_PATH` | 空 | 若挂在子路径反向代理下（如 `/boxadb`）填这里，前端才会把 WS 连对 |

配对相关的一般**不用动**（容器里已给好默认值）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `BOXADB_PIN_PORT` | `5555` | 配对成功后要把盒子调试端口固定成哪个值 |
| `BOXADB_PAIR_PORT` / `BOXADB_PAIR_DAEMON` | `8770` / `/app/pair/daemon.js` | 配对子进程的端口与脚本位置；改前要知道自己在干什么 |
| `BOXADB_NODE_BIN` | `node` | 找不到 Node 时配对能力自动关闭（界面不会出现配对入口），一般只有自建镜像才需要指定 |

## 6. 安全边界（请照着做）

- **只在局域网内使用，不要把 8765/8766 暴露到公网。** 这个桥的作用是「连接到别的主机」，
  上公网等于给人送内网跳板。
- 已内置：目标地址私网白名单、静态服务防路径穿越、非 root 用户运行（65534）、私钥 0600、健康检查。
- 运行基座是 `node:24-alpine`（不再是 scratch），但里面只跑一个 Go 桥和一个配对子进程，
  不额外装包；配对子进程只监听 `127.0.0.1`（日志里就是 `at http://127.0.0.1:8770`），对外仍只有 8765/8766。
- **尚未内置访问鉴权**（同一局域网内任何人都能用这个桥）。多人/不可信网络请自行加反代鉴权，
  或只在可信网段开放。
- 自签证书不是"安全缺陷"，但也不提供真实身份；它只为了满足浏览器的安全上下文要求。

## 7. 与其它两个版本的关系

| 版本 | 适合谁 | 网页在哪 | 桥在哪 |
|---|---|---|---|
| 网页版 `boxadb` | 电脑控制盒子 | GitHub Pages | 本机双击启动 |
| 飞牛原生版 `boxadb-fnos` | 有飞牛 NAS | 飞牛桌面图标（统一网关，天然 https + 登录鉴权） | 常驻 NAS |
| **Docker 版（本文）** | 其它品牌 NAS / 软路由 | 服务自己发，同源 + 自带 https | 常驻该设备 |

三者共用同一套前端与同一个 Go 桥。功能差别只由运行环境决定：

- **「无线调试配对」**需要服务端有 Node：NAS / Docker 版和飞牛原生版有，桌面桥没有（界面上不会出现配对入口）；
- **USB 数据线直连（WebUSB）**需要浏览器拿到 USB：只有网页版和桌面版有，服务端形态不渲染这个入口。

飞牛上也能用 Docker 版，但飞牛用户更推荐原生版（自带登录鉴权、桌面图标、应用中心升级）。

## 8. 卸载

```bash
docker rm -f boxadb && docker volume rm boxadb-data
docker rmi wukongdaily/boxadb:latest    # 自建的话是 boxadb:latest
```
桥只写两样持久数据：那张自签证书和**配对凭据**（都在 `/data` 卷里）。删掉卷就等于每台设备都要重新配一次对。
