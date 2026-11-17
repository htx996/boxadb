# 盒子助手网页版 [![bilibili](https://img.shields.io/badge/B站·教程-A0AABC?style=flat&logo=bilibili&logoColor=fff&labelColor=FB7299&color=3a3a44)](https://www.bilibili.com/video/BV1RwsG6dEd9)


网页版 ADB 助手，专为电视盒子 / Android TV 设计。
**一个网页 → 连上局域网里的盒子 → 装 APK / 终端 / 遥控器 / 截图 / 重启。**

按你的设备选一种用法：

| 用法 | 适合谁 | 需要准备什么 |
|---|---|---|
| **网页版 + 本机桥** | 只在电脑上用 | 双击打开桥接程序，再开网页 |
| **NAS / Docker 版** 🆕 | 家里有 NAS / 软路由，想让手机平板也能随时用 | 一行 `docker run`，之后只开浏览器 |
| **[飞牛 fnOS 原生版](https://github.com/wukongdaily/boxadb-fnos)** | 用飞牛的人 | 装 fpk，从飞牛桌面点图标 |

## 快速开始
电脑打开桥接程序，再打开网页，就能用了<br>
### 桥接程序 https://github.com/wukongdaily/boxadb/releases
1. 双击桌面「BoxADB 桥接」快捷方式 → 弹窗口跑桥（保持别关）
2. 浏览器打开 https://wukongdaily.github.io/boxadb/ ，填盒子 IP（端口 5555 自动补）→ 点「连接设备」
3. 用完关掉那个窗口，端口立即释放，不留后台

## NAS / Docker 版 🆕

网页和桥装在同一个容器里，**局域网内任何设备打开网址就能用**，不用每台电脑再开桥。

```bash
docker run -d --name boxadb --restart unless-stopped \
  -p 8765:8765 -p 8766:8766 \
  -v boxadb-data:/data \
  -e BRIDGE_HOST=0.0.0.0 \
  -e BRIDGE_PORT=8765 \
  -e BRIDGE_HTTPS_PORT=8766 \
  -e BRIDGE_PRIVATE_ONLY=1 \
  -e BRIDGE_STATE_DIR=/data \
  -e BRIDGE_TLS_HOSTS=你的NAS地址 \
  wukongdaily/boxadb:latest
```

把 `你的NAS地址` 换成 NAS 在局域网里的 IP（例如 `192.168.66.218`），然后打开：

```
https://你的NAS地址:8766/
```

第一次会提示"连接不是私密连接"，点 **高级 → 继续访问**，只需点这一次。

几点说明：

- 镜像同时发到两个仓库，内容完全一致：`wukongdaily/boxadb`（Docker Hub）和 `ghcr.io/wukongdaily/boxadb`。国内网络经常连不上 GHCR，拉不到就用 Docker Hub 这份。
- **为什么一定要用 https 打开**：浏览器只在加密页面里开放"生成连接盒子所需密钥"的能力，用 `http://` 打开的页面连不上盒子。所以容器自带一张自签证书，并把 `http://你的NAS地址:8765/` 自动跳到上面的加密地址。
- 默认只允许连接局域网内的设备，且这个服务本身没有登录密码 —— **不要把端口开放到公网**，只在家庭网络里用。
- 挂了 `-v boxadb-data:/data` 这个卷，重启容器不会换证书，不用反复点"继续访问"。
- 完整参数、Docker Compose 写法和常见问题见 [INSTALL-docker.md](INSTALL-docker.md)。

## 支持的浏览器

| 浏览器 | 网页版（Pages） | NAS / Docker 版 |
|---|---|---|
| **Chrome / Edge** | ✅ 推荐 | ✅ |
| **Firefox** | ⚠️ 理论上支持，暂未充分实测 | ⚠️ 同上 |
| **Safari** | ❌ 暂不支持 | ✅ 走加密同源，没有上面那条限制 |

> 网页版打不开 Safari 的原因是它从加密页面连本机明文端口，被浏览器拦掉了；NAS / Docker 版整条链路都是加密同源的，不存在这个问题。

## 飞牛 NAS 版

有飞牛 fnOS 的话，盒子助手还有常驻 NAS 的原生版 [boxadb-fnos](https://github.com/wukongdaily/boxadb-fnos)：经统一网关同源，**手机在客厅也能开网页连盒子**，不必在每台电脑另开桥。

## 第三方组件致谢（均为 MIT）

本项目站在这些优秀开源项目的肩膀上：

- **[@yume-chan/ya-webadb (Tango)](https://github.com/yume-chan/ya-webadb)** —— ADB 协议引擎，感谢 [@yume-chan](https://github.com/yume-chan)（Simon Chan）
- **[@yume-chan/adb-daemon-webusb](https://github.com/yume-chan/ya-webadb)** —— USB 数据线直连（WebUSB）传输组件
- **[xterm.js](https://xtermjs.org/)** —— 浏览器终端
- **[fflate](https://github.com/101arrowz/fflate)** —— APK/XAPK 解包

以上均为 MIT 许可，版权声明与许可全文见 [`js/vendor/THIRD-PARTY-LICENSES.md`](js/vendor/THIRD-PARTY-LICENSES.md)。

## 许可

本项目以 [MIT](LICENSE) 许可开源。
