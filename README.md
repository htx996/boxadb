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
docker run -d --name boxadb --restart unless-stopped --network host \
  -v boxadb-data:/data \
  wukongdaily/boxadb:latest
```

然后打开 NAS 在局域网里的加密地址，把下面的 `你的NAS地址` 换成 NAS 的 IP（例如 `192.168.66.218`）：

```
https://你的NAS地址:8766/
```

第一次会提示"连接不是私密连接"，点 **高级 → 继续访问**，只需点这一次。

几点说明：

- 镜像同时发到两个仓库，内容完全一致：`wukongdaily/boxadb`（Docker Hub）和 `ghcr.io/wukongdaily/boxadb`。国内网络经常连不上 GHCR，拉不到就用 Docker Hub 这份。
- **为什么一定要用 https 打开**：浏览器只在加密页面里开放"生成连接盒子所需密钥"的能力，用 `http://` 打开的页面连不上盒子。所以容器自带一张自签证书，并把 `http://你的NAS地址:8765/` 自动跳到上面的加密地址。
- 默认只允许连接局域网内的设备，且这个服务本身没有登录密码 —— **不要把端口开放到公网**，只在家庭网络里用。
- **`--network host` 不是可选项**：Docker 默认桥接会把连接来源改写成 docker0 虚拟地址，盒子上的 adb 授权就被记到那个假地址上，出现忽好忽坏的未授权；而且「无线调试」的端口广播也收不到，配对时只能手填端口。系统图形界面不支持 host 网络时，退成 `-p 8765:8765 -p 8766:8766` 也能用，只是每次都要自己抄端口。
- 挂了 `-v boxadb-data:/data` 这个卷，重启容器不会换证书，不用反复点"继续访问"。**配对凭据也存在这里**，删卷等于重新配一次对。
- 完整参数、Docker Compose 写法和常见问题见 [INSTALL-docker.md](INSTALL-docker.md)。

## 无线调试配对 🆕

这一节**只适用于带「无线调试」的设备**。市面上很多电视/盒子只需要打开 USB 调试开关即可，无需关注。

### 三种电视/盒子，开哪个开关

| 类型 | 典型机型 | 电视上要开的开关 | 网页上怎么连 |
|---|---|---|---|
| ① 有「无线调试」的选项,但是开了「USB 调试」就能连 | 多数安卓盒子（如 ONN 4K Plus）、大部分老电视 | 设置 → 开发者选项 → **USB 调试**（开了就通，不用碰无线调试） | 填 IP → 连接 |
| ② 有且必须「无线调试」配对 | 2020 款 Google TV、新款索尼电视等 | 设置 → 开发者选项 → **无线调试** 打开；弹窗提示配对时，进「使用配对码配对设备」，把电视显示的码填进网页 | 填 IP → 连接 → 按弹窗提示补配对码 |
| ③ 没有「无线调试」这个选项 | 较老的电视/盒子 | 只有 **USB 调试** 可开，开了就能连（同 ①） | 填 IP → 连接 |

分不清是哪类？**不用分**。先把电视上能找到的调试开关打开，网页里填 IP 点连接——连不上时页面会自动告诉你下一步该开哪个开关、填什么。

需要配对的设备，「无线调试」的端口是随机的，而且**每开关一次就换一个**（实测同一台电视连续出现过 44189、40709、38393、45169…）。配对一次，就是把这个麻烦一次性解决掉。

**哪些版本有配对入口**：NAS / Docker 版、飞牛 fnOS 版、绿联 UGOS 版，以及 v0.1.5 起的电脑桥接程序（网页 + 本机桥）。

**怎么做**（全程在网页上完成，不装 adb、不敲命令）：

1. 电视：**设置 → 开发者选项 → 无线调试**，打开。列表里找不到这一项，就说明这台设备没有这层能力，不用在此耗时。
2. 选 **「使用配对码配对设备」**，第二屏会给出 **6 位配对码** 和 **配对端口**。这个窗口别关，码会过期。
3. 打开盒子助手，填盒子的局域网 IP → 连接：
   - 桥和盒子在同一网段时（NAS 版配了 host 网络、电脑桥默认就是），点 **自动填端口** 就能把端口替你填好；
   - 查不到广播时才需要手填：① 连接端口，② 配对端口 + 6 位配对码。
4. 提交。配对成功后盒子助手会**把连接端口固定成 5555**，以后重开「无线调试」开关就能直接连，**不用再输配对码**。

> 电视上弹的授权窗写的是「**允许 USB 调试**」——连的是网络端口它也这么写，不是走错了路，点允许就行。

电视重启后要留意：无线调试开关会自动回到关闭状态，重新打开即可，这一步不需要重新输码（NAS / Docker 版的凭据在 `boxadb-data` 卷里，删卷才要重配；电脑版的凭据存在桥接程序自己的数据目录，重启电脑、换浏览器都还在）。

屏幕上的提示怎么读：

| 提示 | 该怎么办 |
|---|---|
| 配对码不对或已过期 | 回电视上那个窗口，重新抄一遍 6 位码 |
| 没查到无线调试广播 | 确认电视「无线调试」已打开；或手填端口 |
| 这台配过对，② 留空即可 | 凭据还在，把 ① 连上就行 |

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

## ❤️ 想支持作者 ☕️
<a href="https://wkdaily.cpolar.top/01" target="_blank">
  <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png"
       alt="Buy Me A Coffee"
       style="width:15%; height:auto;">
</a>
