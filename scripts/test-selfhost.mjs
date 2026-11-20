// 自托管（Docker/NAS）形态桥的行为测试：静态发页 + 桥隧道 + 私网白名单 + 桌面版无回归
// 自托管（Docker/NAS）形态桥的行为回归测试。
// 用法（仓库根目录）：
//   go build -ldflags="-s -w" -o /tmp/bridge-desktop .
//   bash scripts/make-webapp.sh
//   go build -tags withwebapp -ldflags="-s -w" -o /tmp/bridge-server .
//   node scripts/test-selfhost.mjs /tmp/bridge-desktop /tmp/bridge-server
// 覆盖：桌面版零回归 / 静态发页与 MIME / 运行时自托管注入 / 路径穿越 / 私网白名单 / WS↔TCP 回环
import { spawn } from 'node:child_process';
import net from 'node:net';
import crypto from 'node:crypto';
import tls from 'node:tls';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [DESKTOP, SERVER] = process.argv.slice(2);
const P_DESKTOP = 18766, P_SERVER = 18767, P_ECHO = 15555;
const P_TLS = 18771;          // 主实例的内置 https
const P_REUSE_HTTP = 18774, P_REUSE_TLS = 18775;  // 复用同一证书目录的实例
const P_NO_TLS = 18776;                          // https 关闭的实例
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'boxadb-tls-'));
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✅ ' + m)) : (fail++, console.log('  ❌ ' + m)); };

const get = (port, path, headers = {}) => new Promise((res, rej) => {
  const req = http.request({ port, path, headers }, (r) => {
    let b = ''; r.on('data', (d) => b += d); r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: b }));
  });
  req.on('error', rej); req.end();
});
const getTLS = (port, p) => new Promise((res, rej) => {
  const req = https.request({ port, path: p, rejectUnauthorized: false }, (r) => {
    let b = ''; r.on('data', (d) => b += d); r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: b }));
  });
  req.on('error', rej); req.end();
});
const waitUp = async (port) => { for (let i = 0; i < 60; i++) { try { const r = await get(port, '/health'); if (r.status) return; } catch {} await new Promise(r => setTimeout(r, 250)); } throw new Error('端口 ' + port + ' 没起来'); };

// 带 WS 头的隧道探测：必须带 Upgrade/Sec-WebSocket-Key 才能走到「白名单 → dial」这两步
function probeTunnelStatus(port, host, targetPort) {
  return new Promise((res, rej) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(`GET /adb?host=${host}&port=${targetPort} HTTP/1.1\r\nHost: x\r\n` +
        `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const status = Number((buf.subarray(0, 12).toString().match(/ (\d{3})/) || [])[1]);
      const body = buf.subarray(end + 4).toString();
      sock.destroy(); res({ status, body });
    });
    sock.on('error', rej);
    setTimeout(() => { sock.destroy(); rej(new Error('探测超时')); }, 9000);
  });
}

// WS 客户端（手写帧，掩码必须加 —— 客户端发帧要求掩码）
function wsTunnel(port, host, targetPort) {
  return new Promise((res, rej) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(`GET /adb?host=${host}&port=${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
        `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let stage = 'handshake', buf = Buffer.alloc(0), done = false;
    const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
    const expect = crypto.createHash('sha1').update(key + GUID).digest('base64');
    const timer = setTimeout(() => { if (!done) rej(new Error('隧道无数据回传')); }, 6000);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 'handshake') {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.subarray(0, end).toString();
        buf = buf.subarray(end + 4);
        if (!head.startsWith('HTTP/1.1 101')) { done = true; clearTimeout(timer); sock.destroy(); return rej(new Error('未升级: ' + head.split('\r\n')[0])); }
        if (!head.includes(expect)) { done = true; clearTimeout(timer); sock.destroy(); return rej(new Error('Sec-WebSocket-Accept 不对')); }
        stage = 'frames';
        const mask = crypto.randomBytes(4), text = Buffer.from('boxadb-selfhost-ping');
        const f = Buffer.alloc(6 + text.length);
        f[0] = 0x82; f[1] = 0x80 | text.length; mask.copy(f, 2);
        for (let i = 0; i < text.length; i++) f[6 + i] = text[i] ^ mask[i % 4];
        sock.write(f);
        return;
      }
      if (buf.length >= 2) {
        const len = buf[1] & 0x7f, hdr = 2 + (buf[1] & 0x80 ? 4 : 0) + (len === 126 ? 2 : len === 127 ? 8 : 0);
        if (buf.length < hdr + len) return;
        done = true; clearTimeout(timer);
        res({ sock, payload: buf.subarray(hdr, hdr + len) });
      }
    });
  });
}

let procs = [], spawned = [];
const run = (bin, env) => {
  const p = spawn(bin, [], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const rec = { out: '' };
  p.stdout.on('data', (d) => { rec.out += d; process.stdout.write('    [' + p.pid + '] ' + d); });
  p.stderr.on('data', (d) => { rec.out += d; });
  spawned.push(rec); procs.push(p); return p;
};
const spawnedLog = (i) => (spawned[i] ? spawned[i].out : '');


// —— TLS 侧助手（openssl 读证书，不依赖 node 的证书解析差异）——
function certTextFromState(dir) {
  const r = spawnSync('openssl', ['x509', '-in', dir + '/tls.crt', '-noout', '-text'], { encoding: 'utf8', timeout: 8000 });
  return (r.stdout || '') + (r.stderr || '');
}
function getCertSan(dir) {
  const m = /Subject Alternative Name([\s\S]{0,900}?)\n\s+Signature Algorithm/.exec(certTextFromState(dir));
  return m ? m[1] : '';
}
function certFileHash(dir) {
  if (!fs.existsSync(dir + '/tls.crt')) return '';
  return crypto.createHash('sha256').update(fs.readFileSync(dir + '/tls.crt')).digest('hex').slice(0, 16);
}

function reqHost(port, p, hostHeader) {
  return new Promise((res, rej) => {
    const req = http.request({ port, path: p, headers: { Host: hostHeader } }, (r) => {
      let b = ''; r.on('data', (d) => b += d); r.on('end', () => res({ status: r.statusCode, location: r.headers.location, body: b }));
    });
    req.on('error', rej); req.end();
  });
}
function wsTunnelTLS(port, host, targetPort) {
  return new Promise((res, rej) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false }, () => {
      sock.write(`GET /adb?host=${host}&port=${targetPort} HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
        `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let buf = Buffer.alloc(0), stage = 'handshake', done = false;
    const expect = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    const timer = setTimeout(() => { if (!done) rej(new Error('wss 无数据')); }, 6000);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 'handshake') {
        const e = buf.indexOf('\r\n\r\n'); if (e < 0) return;
        const head = buf.subarray(0, e).toString(); buf = buf.subarray(e + 4);
        if (!head.startsWith('HTTP/1.1 101') || !head.includes(expect)) { done = true; clearTimeout(timer); sock.destroy(); return rej(new Error('wss 握手失败')); }
        stage = 'frames';
        const mask = crypto.randomBytes(4), text = Buffer.from('boxadb-selfhost-ping');
        const f = Buffer.alloc(6 + text.length); f[0] = 0x82; f[1] = 0x80 | text.length; mask.copy(f, 2);
        for (let i = 0; i < text.length; i++) f[6 + i] = text[i] ^ mask[i % 4];
        sock.write(f); return;
      }
      if (buf.length >= 2) {
        const len = buf[1] & 0x7f, hdr = 2 + (buf[1] & 0x80 ? 4 : 0) + (len === 126 ? 2 : len === 127 ? 8 : 0);
        if (buf.length < hdr + len) return;
        done = true; clearTimeout(timer); sock.destroy();
        res(buf.subarray(hdr, hdr + len).toString());
      }
    });
    sock.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); rej(e); } });
  });
}

try {
  // 一个私网 echo 靶子（用 127.0.0.1，属回环=私网允许）
  const echo = net.createServer((s) => s.on('data', (d) => s.write(d)));
  await new Promise(r => echo.listen(P_ECHO, '127.0.0.1', r));

  console.log('\n【1】桌面版构建 = 行为必须和以前一致');
  run(DESKTOP, { BRIDGE_PORT: String(P_DESKTOP) });
  await waitUp(P_DESKTOP);
  const d1 = await get(P_DESKTOP, '/health'); ok(d1.status === 200 && d1.body.includes('boxadb bridge ok'), '/health 200');
  const d2 = await get(P_DESKTOP, '/'); ok(d2.status === 404, '根路径 404（桌面版不发网页 ✓ 无变化）');
  const d2b = await get(P_DESKTOP, '/index.html'); ok(d2b.status === 404, '桌面版不吐任何前端文件 ✓');
  ok(/https 已关闭/.test(spawnedLog(0)), '桌面版默认不开 https（不多监听一个端口）');
  const d3 = await probeTunnelStatus(P_DESKTOP, '8.8.8.8', '5555');
  ok(d3.status !== 403, '公网目标不被新白名单拦（桌面版零回归）→ 实际 ' + d3.status);

  console.log('\n【2】自托管构建（-tags withwebapp）= 网页 + 桥同源');
  run(SERVER, { BRIDGE_HOST: '127.0.0.1', BRIDGE_PORT: String(P_SERVER), BRIDGE_HTTPS_PORT: String(P_TLS), BRIDGE_STATE_DIR: STATE });
  await waitUp(P_SERVER);
  const s0 = await get(P_SERVER, '/');
  ok(s0.status === 200 && s0.body.includes('<title>') && s0.body.includes('id="device-ip"'), 'GET / 返回完整盒子助手页面');
  const meta = 'meta[name="boxadb-mode"][content="selfhosted"]';
  ok(s0.body.includes('name="boxadb-mode" content="selfhosted"'), '运行时注入自托管标记（网页与桥同源的关键）');
  ok(s0.body.includes('name="boxadb-prefix" content=""'), '容器形态前缀为空');
  ok((s0.body.match(/boxadb-mode/g) || []).length === 1, '标记只注入一次（不重复）');
  const s1 = await get(P_SERVER, '/js/tango.js');
  ok(s1.status === 200 && s1.body.includes('meta[name="boxadb-mode"]') && s1.body.includes('meta[name="boxadb-prefix"]'),
    'tango.js 带运行时探测（未被构建期改写）');
  ok(s1.body.includes('BRIDGE_BASE = selfHosted'), 'BRIDGE_BASE 走 selfHosted 分支');
  ok(/javascript/i.test(s1.headers['content-type'] || ''), 'JS 以 javascript MIME 返回（ESM 才能执行）');
  const s1b = await get(P_SERVER, '/index.html');
  ok(s1b.status === 200 && s1b.body.includes('name="boxadb-mode"'), '/index.html 同样带标记');
  // WebUSB 连的是「打开网页那台电脑」的 USB，与 NAS 桥走网络的定位冲突：
  // 自托管形态必须从静态 HTML 起就不出现（连闪一下都不允许），也不能靠构建期删元素
  ok(/id="usb-toggle"[^>]*\shidden\b/.test(s0.body), '自托管 HTML 里「USB 直连」默认 hidden（Docker 版永不出现）');
  const sU = await get(P_SERVER, '/js/app.js');
  ok(sU.status === 200 && /if \(!SELF_HOSTED && navigator\.usb\)/.test(sU.body),
    'app.js 只在 Pages/桌面 + 浏览器支持 WebUSB 时才显示该入口');
  ok(sU.body.includes("const SELF_HOSTED = !!document.querySelector"),
    'app.js 用注入的 meta 判定形态（前端仍是未被改写的原件）');
  ok(/no-store/i.test(s1.headers['cache-control'] || ''), '静态响应带 Cache-Control: no-store（不会「改了没生效」）');
  const s2 = await get(P_SERVER, '/css/style.css'); ok(s2.status === 200, '/css/style.css 200');
  const s3 = await get(P_SERVER, '/assets/logo.png'); ok(s3.status === 200 && s3.headers['content-type']?.includes('png'), '/assets/logo.png 200 (image/png)');
  const s4 = await get(P_SERVER, '/js/vendor/adb.js'); ok(s4.status === 200, 'vendor 引擎可取（ESM 依赖链完整）');

  console.log('\n【3】安全：路径穿越 + 私网白名单');
  for (const p of ['/../go.mod', '/..%2fbridge.go', '/%2e%2e/bridge.go', '/../webapp_on.go']) {
    const r = await get(P_SERVER, encodeURI(p));
    ok(!/module boxadb-bridge|package main|go 1\.21/.test(r.body), `穿越被拒 ${p} → ${r.status}`);
  }
  const t1 = await probeTunnelStatus(P_SERVER, '8.8.8.8', '5555');
  ok(t1.status === 403, '公网目标被 403 拦下（SSRF 收口生效）');
  const t2 = await probeTunnelStatus(P_SERVER, '127.0.0.1', '19999');
  ok(t2.status === 502, '私网无人监听 → 502（白名单已放行到 dial 这一步）');
  const t3 = await probeTunnelStatus(P_SERVER, '192.168.66.172', '5555');
  ok(t3.status === 502 || t3.status === 101, '真实盒子地址被允许进入 dial（502=没醒 / 101=能连）→ 实际 ' + t3.status);
  const t4 = await probeTunnelStatus(P_SERVER, 'abc', '5555'); ok(t4.status === 400, '非法 host → 400');
  const t5 = await probeTunnelStatus(P_SERVER, '127.0.0.1', '99999'); ok(t5.status === 400, '非法端口 → 400');

  console.log('\n【4】真实隧道：WS 握手 + 字节回环');
  try { const r = await wsTunnel(P_SERVER, '127.0.0.1', P_ECHO); ok(r.payload?.toString() === 'boxadb-selfhost-ping', 'WS↔TCP 双向搬运原样返回'); r.sock.destroy(); }
  catch (e) { ok(false, '隧道回环：' + e.message); }

  console.log('\n【5】BRIDGE_PRIVATE_ONLY=0 可放开（连远端盒子/Tailscale 场景）');
  run(SERVER, { BRIDGE_HOST: '127.0.0.1', BRIDGE_PORT: '18768', BRIDGE_HTTPS_PORT: '0', BRIDGE_PRIVATE_ONLY: '0' });
  await waitUp(18768);
  const o1 = await probeTunnelStatus(18768, '8.8.8.8', '5555');
  ok(o1.status !== 403, '放开后公网目标不再 403 → 实际 ' + o1.status);


  console.log('\n【6】内置自签 HTTPS（手机/局域网可用的关键）');
  const h0 = await getTLS(P_TLS, '/health');
  ok(h0.status === 200 && h0.body.includes('boxadb bridge ok'), 'https /health 200（自签证书可用）');
  const h1 = await getTLS(P_TLS, '/');
  ok(h1.status === 200 && h1.body.includes('name="boxadb-tls-port" content="' + P_TLS + '"'), 'https 页面注入 tls-port');
  ok(h1.body.includes('id="insecure-tls"'), '弹窗含「用加密方式打开」按钮');
  const certInfo = getCertSan(STATE);
  ok(/127\.0\.0\.1/.test(certInfo), '证书 SAN 含 127.0.0.1');
  ok(/192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\./.test(certInfo), '证书 SAN 含本机局域网地址（手机才点得开）');
  ok(/DNS:localhost/.test(certInfo), '证书 SAN 含 localhost');
  ok(/IP Address:0:0:0:0:0:0:0:1/.test(certInfo), '证书 SAN 含 IPv6 回环');

  const redir = await reqHost(P_SERVER, '/', '192.168.66.188:' + P_SERVER);
  ok(redir.status === 302 && redir.location === `https://192.168.66.188:${P_TLS}/`,
     `局域网 http 地址自动跳 https（${redir.status} ${redir.location || ''}）`);
  const keep = await reqHost(P_SERVER, '/', 'localhost:' + P_SERVER);
  ok(keep.status === 200, 'localhost 不跳转（SSH 端口转发那条路保持可用）');
  const hKeep = await reqHost(P_SERVER, '/health', '192.168.66.188:' + P_SERVER);
  ok(hKeep.status === 200, '/health 不被跳转（探针与调试直连）');
  const aKeep = await probeTunnelStatus(P_SERVER, '127.0.0.1', '19999');
  ok(aKeep.status === 502, '/adb 不被跳转（隧道仍走原逻辑）');

  const wss = await wsTunnelTLS(P_TLS, '127.0.0.1', P_ECHO);
  ok(wss === 'boxadb-selfhost-ping', 'wss 隧道字节原样回环');

  console.log('\n【7】证书持久化与 https 关闭态');
  ok(fs.existsSync(path.join(STATE, 'tls.crt')) && fs.existsSync(path.join(STATE, 'tls.key')), 'tls.crt / tls.key 已落盘');
  ok((fs.statSync(path.join(STATE, 'tls.key')).mode & 0o777) === 0o600, '私钥权限 0600');
  const fp1 = certFileHash(STATE);
  const stateBefore = fs.readFileSync(STATE + '/tls.crt', 'utf8');
  run(SERVER, { BRIDGE_HOST: '127.0.0.1', BRIDGE_PORT: String(P_REUSE_HTTP), BRIDGE_HTTPS_PORT: String(P_REUSE_TLS), BRIDGE_STATE_DIR: STATE });
  await waitUp(P_REUSE_HTTP);
  const reuseLog = spawnedLog(spawned.length - 1);
  ok(/复用已存自签证书|证书已复用/.test(reuseLog), '第二个实例日志显示复用已存证书');
  ok(certFileHash(STATE) === fp1 && stateBefore === fs.readFileSync(STATE + '/tls.crt', 'utf8'), '重启复用同一张证书（无需重新点「继续访问」）');
  const reuseTls = await getTLS(P_REUSE_TLS, '/health');
  ok(reuseTls.status === 200, '复用证书也能正常提供 https');
  run(SERVER, { BRIDGE_HOST: '127.0.0.1', BRIDGE_PORT: String(P_NO_TLS), BRIDGE_HTTPS_PORT: '0' });
  await new Promise(r => setTimeout(r, 900));
  const noTlsRedir = await reqHost(P_NO_TLS, '/', '192.168.66.188:' + P_NO_TLS);
  ok(noTlsRedir.status === 200, 'BRIDGE_HTTPS_PORT=0 时不做跳转（不会跳去不存在的端口）');
  console.log('\n【8】加密访问引导按形态分流（行为级：DOM 桩里真跑一遍 showInsecureDialog）');
  const APPJS = ['js/app.js', '../js/app.js'].map((f) => path.resolve(process.cwd(), f)).find((f) => fs.existsSync(f));
  ok(!!APPJS, '找到 app.js 源文件（本段是对真实源码求值，不是比对字符串）');
  const srcApp = fs.readFileSync(APPJS, 'utf8');
  ok(!/const selfHost = SELF_HOSTED/.test(srcApp), '弹窗判定不再复用 SELF_HOSTED（那个常量只管 WebUSB 入口）');

  // 从源码里抠出函数体（配平花括号），用桩环境真实执行，验证三种形态各走各的引导
  const extractFn = (src, name) => {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) return '';
    let depth = 0;
    for (let k = src.indexOf('{', i); k < src.length; k++) {
      if (src[k] === '{') depth++;
      else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1);
    }
    return '';
  };
  const runDialog = ({ selfHosted, metas = {} }) => {
    const els = {};
    const $ = (sel) => (els[sel] = els[sel] || { hidden: true, textContent: '', onclick: null });
    const doc = { querySelector: (sel) => {
      const m = /meta\[name="([^"]+)"\]/.exec(sel);
      return m && m[1] in metas ? { content: metas[m[1]] } : null;
    } };
    const loc = { hostname: '192.168.66.50', pathname: '/', search: '', replace() {} };
    const win = { self: {}, top: {}, open() { return {}; } };
    const body = extractFn(srcApp, 'showInsecureDialog');
    const fn = new Function('SELF_HOSTED', 'document', 'location', 'window', '$', 'toast', 'insecureFixUrl',
      body + ';return showInsecureDialog;')(selfHosted, doc, loc, win, $, () => {},
        () => 'https://192.168.66.50:5667/');
    fn();
    return els;
  };
  // 「设备没在 5555 上监听」这条分支：必须只在失败时才要端口，且不再把用户推去电脑上敲 adb
  const sPort = await get(P_SERVER, '/index.html');
  ok(/id="port-modal"[^>]*\shidden/.test(sPort.body), '端口对话框默认 hidden（平时界面里看不到端口输入）');
  ok(sU.body.includes("err.code === 'NEED_PORT' || err.code === 'BRIDGE_UNREACHABLE'") && sU.body.includes('showPortDialog(ip, err.code)'), 'A（端口无反应）与 C（拒绝明文）都会给出填端口的机会');
  const sT = await get(P_SERVER, '/js/tango.js');
  ok(sT.body.includes('export async function enableTcpip'), 'tango.js 提供 enableTcpip（走 ADB 通道切端口）');
  ok(!sT.body.includes('请先完成 adb tcpip 5555'), '不再让用户去电脑上敲 adb（旧文案已清除）');
  ok(sU.body.includes('必须用无线调试配对，目前还不支持'), '填了端口仍连不上时，直接说明是配对类设备（不再重复提 5555）');
  ok(/id="diag"[^>]*\shidden/.test(sPort.body), '诊断面板默认 hidden（正常用户看不到任何分类信息）');
  ok(sU.body.includes("location.search.includes('diag=1')"), '诊断面板只在 ?diag=1 时出现');
  ok(sT.body.includes("export function getDiag") && /diag\.kind = 'C-/.test(sT.body), 'tango.js 按 A/B/C/D/E 分类记录失败原因');
  ok(sT.body.includes("r('stall'), 8000") && sU.body.includes('onStall:'), '端口 8 秒无响应就明确告知是 TLS 配对端口（不让用户干等 30 秒）');
  ok(/id="port-stall"[^>]*\shidden/.test(sPort.body), '弹窗里的“无响应”说明默认不显示，只在超时时出现');

  const dDocker = runDialog({ selfHosted: true, metas: { 'boxadb-mode': 'selfhosted', 'boxadb-prefix': '', 'boxadb-tls-port': '8766' } });
  ok(dDocker['#insecure-selfhost'].hidden === false && dDocker['#insecure-fnos'].hidden === true,
    'Docker/NAS 容器（有 boxadb-tls-port）→ 只显示自托管 https 引导');
  ok(dDocker['#insecure-tls'].hidden === false && /8766/.test(dDocker['#insecure-tls-url'].textContent),
    '容器形态给出可用的「用加密方式打开」按钮与 8766 地址');
  const dFnos = runDialog({ selfHosted: true, metas: { 'boxadb-mode': 'selfhosted', 'boxadb-prefix': '/app/boxadb' } });
  ok(dFnos['#insecure-fnos'].hidden === false && dFnos['#insecure-selfhost'].hidden === true,
    '飞牛形态（无 tls-port、SELF_HOSTED=true）→ 仍显示「打开飞牛加密主页」引导');
  ok(dFnos['#insecure-tls'].hidden === true && /5667/.test(dFnos['#insecure-url'].textContent),
    '飞牛形态不出 https 按钮，飞牛 5667 地址正常给出');
  const dPages = runDialog({ selfHosted: false, metas: {} });
  ok(dPages['#insecure-fnos'].hidden === true && dPages['#insecure-selfhost'].hidden === true && dPages['#insecure-tls'].hidden === true,
    '桌面/Pages 形态不会误显示任一套 NAS 引导');

  // ── 无线调试配对入口（前端只做表单与形态门控，协议在桥里）──
  console.log('\n[无线调试 · 前端接线]');
  {
    const rd = (rel) => fs.readFileSync([rel, '../' + rel].map((f) => path.resolve(process.cwd(), f)).find((f) => fs.existsSync(f)), 'utf8');
    const html = rd('index.html'), app = rd('js/app.js'), tg = rd('js/tango.js');
    const iConn = html.indexOf('id="port-input"'), iPair = html.indexOf('id="pair-port-input"');
    ok(iConn > 0 && iPair > iConn, '表单顺序：① 连接端口在 ② 配对端口之前');
    ok(/id="pair-code-input"[^>]*maxlength="6"/.test(html), '配对码输入框限 6 位');
    {
      const iCode = html.indexOf('id="pair-code-input"'), iPP = html.indexOf('id="pair-port-input"');
      ok(iCode > 0 && iCode < iPP, '② 组内顺序：左配对码、右配对端口（与电视第二屏一致）');
      ok(/class="pair-code"[^>]*maxlength="6"/.test(html), '配对码框为大号 6 位输入');
      {
        const iRow = html.indexOf('id="port-input"'), iBtn = html.indexOf('id="port-detect"'), iG2 = html.indexOf('id="pair-group"');
        ok(iBtn > iRow && iBtn < iG2, '「自动填端口」在 ① 行内（第一屏的事归第一屏）');
        ok(/>自动填端口</.test(html) && !html.includes('自动查端口'), '按钮文案为「自动填端口」，旧名已消失');
        ok(html.includes('没查到无线调试广播') || app.includes('没查到无线调试广播'), '查不到时说清楚，不假装成功');
      {
        const css = fs.readFileSync(rd('css/style.css'), 'utf8');
        const zToast = +(css.match(/\.toasts\{[^}]*z-index:\s*(\d+)/) || [])[1];
        const zModal = +(css.match(/#insecure-modal,#port-modal\{[^}]*z-index:\s*(\d+)/) || [])[1];
        ok(zToast > zModal, `dialog 出现时右下角提示仍可见（toasts ${zToast} > modal ${zModal}）`);
        ok(html.includes('id="pair-allow"'), '弹窗里有「等电视点允许」的显式状态块');
        ok(app.includes("why === 'await-allow'"), 'stall 分成「等允许」与「疑似 TLS」两类');
        ok(app.includes('authTimeoutMs: 90000'), '配对后首连给足 90 秒等人点允许，不再 8 秒判死');
        ok(/还在等电视|我点过允许了，再连一次/.test(app), '超时话术改成「点完再连」，不是「没成功」');
        ok(tg.includes('inbound') && tg.includes('stream.inbound() > 0'), 'tango 用入向字节判定：有来文就不是 TLS 端口');
      }
      }
    }
    ok(!/目前还不能配对|目前还不支持/.test(html), '旧的「不支持配对」文案已清除');
    ok(html.indexOf('使用配对码配对设备') > 0, '文案告诉用户第二屏才有配对码');
    ok(app.includes('await autoRecover(ip)') && app.indexOf('autoRecover(ip)') < app.indexOf('showPortDialog(ip, err.code)'),
      '先静默用已存凭据自愈，失败才弹表单');
    ok(app.includes('pg.hidden = !canPair') && app.includes('const canPair = await pairAvailable()'),
      '配对区按「桥的能力」显示，不是按形态常量瞎猜（Docker 的 Go 桥没这三接口 → 不出入口）');
    ok(tg.includes('wirelessAvailable') && tg.includes("discoverWireless().then(() => true).catch(() => false)"),
      'tango 用一次 /discover 探测桥是否支持配对');
    ok(app.includes('if (!(await pairAvailable())) return false'), '不支持配对的桥不会白跑一次 recover');
    ok(app.includes('T.pairWireless(') && app.includes('T.discoverWireless()') && app.includes('T.recoverWireless(ip)'),
      '三个接口都接上了');
    ok(/\^\\d\{6\}\$/.test(app), '提交前校验 6 位配对码');
    ok(tg.includes('export const wirelessSupported = selfHosted'), 'tango 明确：只有自托管支持配对');
    for (const r of ["'/discover'", "'/pair'", "'/recover'"]) ok(tg.includes(r), `桥接口 ${r}`);
    ok(tg.includes("if (d && d.error)") && tg.includes('d.hint || d.error'), '桥返回的 hint 会透传成用户看得懂的话');
    const kinds = ["'code'", "'tls'", "'cnxn'", "'plaintext'", "'pair-tls'"];
    ok(kinds.every(k => app.includes('err.code===' + k) || app.includes('err.code === ' + k)), '失败分类文案覆盖五种落点');
  }

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
} catch (e) {
  console.log('测试异常：' + e.message);
  process.exitCode = 1;
} finally {
  procs.forEach(p => { try { p.kill('SIGTERM'); } catch {} });
  process.exit(process.exitCode || (fail ? 1 : 0));
}
