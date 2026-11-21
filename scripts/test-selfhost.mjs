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

const __dirnameOf = () => path.dirname(new URL(import.meta.url).pathname);
// 读仓库内文件：兼容从仓库根或 scripts/ 目录起跑
const rd = (rel) => fs.readFileSync([rel, '../' + rel].map((f) => path.resolve(process.cwd(), f)).find((f) => fs.existsSync(f)), 'utf8');
const postJSON = (port, p, obj) => new Promise((res) => {
  const body = JSON.stringify(obj);
  const rq = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (rs) => {
    let b = ''; rs.on('data', (c) => (b += c)); rs.on('end', () => res({ code: rs.statusCode, body: b }));
  });
  rq.on('error', () => res({ code: 0, body: '' }));
  rq.write(body); rq.end();
});
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
  ok(!sU.body.includes('目前还不支持'), '不再出现「不支持配对」这种过期文案（现在能配对了）');
  ok((sU.body.includes("err.code==='code'") || sU.body.includes("err.code === 'code'")) && sU.body.includes('配对码不对或已过期'),
    '配对失败按落点给话：配对码不对/已过期');
  ok(/id="diag"[^>]*\shidden/.test(sPort.body), '诊断面板默认 hidden（正常用户看不到任何分类信息）');
  ok(sU.body.includes("location.search.includes('diag=1')"), '诊断面板只在 ?diag=1 时出现');
  ok(sT.body.includes("export function getDiag") && /diag\.kind = 'C-/.test(sT.body), 'tango.js 按 A/B/C/D/E 分类记录失败原因');
  ok(sT.body.includes("r('stall'), stallMs") && sU.body.includes('onStall'), '端口短时无响应就给出分类，不让用户干等 30 秒');
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
        const css = rd('css/style.css');
        const zToast = +(css.match(/\.toasts\{[^}]*z-index:\s*(\d+)/) || [])[1];
        const zModal = +(css.match(/#insecure-modal,#port-modal\{[^}]*z-index:\s*(\d+)/) || [])[1];
        ok(zToast > zModal, `dialog 出现时右下角提示仍可见（toasts ${zToast} > modal ${zModal}）`);
        ok(html.includes('id="pair-allow"'), '弹窗里有「等电视点允许」的显式状态块');
        ok(app.includes("why === 'await-allow'"), 'stall 分成「等允许」与「疑似 TLS」两类');
      ok(app.includes("r.need === 'enable-wireless'") && app.includes('waitWirelessOn('),
        '配过对的盒子重启后：只提示开无线调试开关并自动等，不弹配对 dialog');
      ok(!html.includes('pair-wait') && !css.includes('.pair-wait'),
        '不再有顶部提示条：提示统一走右下角 toast（保持既有交互一致）');
      ok(css.includes('[hidden]{display:none!important}'),
        '全局 [hidden] 规则：自定义 display 不会把 hidden 元素变成一加载就显示');
      ok((app.match(/await autoRecover\(ip\)/g) || []).length === 1,
        '只在点「连接」时才探测自愈，页面加载不探测');
        ok(app.includes('authTimeoutMs: 90000'), '配对后首连给足 90 秒等人点允许，不再 8 秒判死');
      ok(app.includes('setTimeout(r, 2000)') && app.includes('if (!busy)') && app.includes('recoverWireless(ip, true)'),
        '等待时 2 秒一轮，且上一轮没回来不叠加新轮');
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
    ok(tg.includes('wirelessAvailable') && tg.includes('Array.isArray(d.connect)'),
      'tango 探测要求「响应像发现结果」才算支持：200+HTML 的 SPA 兜底骗不出死控件');
    {
      // 真跑一遍判定：四种桥各给什么结论（Pages / Go 桥 404 / SPA 兜底 200 / 真实现）
      const i2 = tg.indexOf('export function wirelessAvailable');
      const srcW = 'let wirelessProbe = null;\n' + tg.slice(i2, tg.indexOf('\n}', i2) + 2).replace('export function', 'function');
      const runW = async (selfHosted, impl) => {
        const mk = new Function('selfHosted', 'discoverWireless', srcW + '\nreturn wirelessAvailable;');
        return await mk(selfHosted, impl)();
      };
      ok(await runW(false, async () => ({ connect: [] })) === false, 'Pages/桌面形态：不探测也不开放');
      ok(await runW(true, async () => { throw new Error('HTTP 404'); }) === false,
        'Docker 的 Go 桥没这三个接口 → 判定不支持（用户看不到配对区与倒计时）');
      ok(await runW(true, async () => ({})) === false, '桥若加了 SPA 兜底（200+HTML）也不会误开');
      {
        const apiSrc = rd('pair/api.js');
        ok(apiSrc.includes("need: 'manual-port'") && apiSrc.includes('容器网络隔离查不到'),
          '查不到广播时落点是 manual-port：容器网络隔离不被误判成"没配过对"');
        ok(!/if \(noService\) return \{ ok: false, need: 'pair'/.test(apiSrc),
          '不再把"查不到广播"直接判成需要配对');
      }
      ok(await runW(true, async () => ({ connect: [], pairing: [] })) === true, '桥真实现了才放开入口');
    }
    ok(app.includes('if (!(await pairAvailable())) return false'), '不支持配对的桥不会白跑一次 recover');
    ok(app.includes("canPair ? '这个端口不接受明文连接，需要配对' : '这个端口只接受加密连接'")
       && app.includes('还不能配对'),
      '桥不支持配对时，dialog 不再只说「需要配对」把用户逼进死路，而给出可执行替代');
    ok(app.includes('.pairWireless(') && app.includes('.discoverWireless(') && app.includes('.recoverWireless('),
      '三个接口都接上了');
    ok(/\^\\d\{6\}\$/.test(app), '提交前校验 6 位配对码');
    ok(tg.includes('export const wirelessSupported = selfHosted'), 'tango 明确：只有自托管支持配对');
    for (const r of ["'/discover'", "'/pair'", "'/recover'"]) ok(tg.includes(r), `桥接口 ${r}`);
    ok(tg.includes("if (d && d.error)") && tg.includes('d.hint || d.error'), '桥返回的 hint 会透传成用户看得懂的话');
    const kinds = ["'code'", "'tls'", "'cnxn'", "'plaintext'", "'pair-tls'"];
    ok(kinds.every(k => app.includes('err.code===' + k) || app.includes('err.code === ' + k)), '失败分类文案覆盖五种落点');
  }


  // ── 全屏等待倒计时（假 DOM 真跑一遍）──
  console.log('\n[等待提示 · 全屏倒计时]');
  {
    const htmlC = rd('index.html');
    ok(/id="pair-countdown"[^>]*\shidden/.test(htmlC), '倒计时遮罩默认 hidden');
    ok(htmlC.includes('id="cd-num"') && htmlC.includes('id="cd-bar"') && htmlC.includes('id="cd-cancel"'), '大数字、圆环、取消按钮都在结构里');
    ok(htmlC.includes('id="cd-text-a"') && htmlC.includes('id="cd-text-b"'), '文案拆成两行（引导行 + 重点行）');
    ok(!/class="cd-text"[^>]*>请在电视\/盒子上打开「无线调试」开关</.test(htmlC), '不再把一长句塞进大字行');
    const cssC = rd('css/style.css');
    const zCd = +(cssC.match(/\.cd-mask\{[^}]*z-index:\s*(\d+)/) || [])[1];
    const zModal = +(cssC.match(/#insecure-modal,#port-modal\{[^}]*z-index:\s*(\d+)/) || [])[1];
    ok(zCd > zModal, `倒计时盖在 dialog 之上（${zCd} > ${zModal}）`);
    ok(cssC.includes('.cd-dial{position:relative') && cssC.includes('.cd-num{position:absolute'), '秒数定位在圆环中心（有定位父级，不会飘走）');

    const srcFn = extractFn(rd('js/app.js'), 'showCountdown');
    ok(srcFn.length > 0, '能取出 showCountdown 实现');
    const mk = () => ({ hidden: true, textContent: '', style: {}, onclick: null });
    const els = { '#pair-countdown': mk(), '#cd-text-a': mk(), '#cd-text-b': mk(), '#cd-num': mk(), '#cd-bar': mk(), '#cd-cancel': mk() };
    const $ = (sel) => els[sel];
    let beat = null, cleared = 0;
    const f = new Function('$', 'CD_LEN', 'setInterval', 'clearInterval',
      srcFn + '\nreturn showCountdown;')($, 339.29, (fn) => { beat = fn; return 1; }, () => { cleared++; });
    let cancelled = false;
    const ctl = f(90, null, () => { cancelled = true; });
    ok(els['#pair-countdown'].hidden === false, '调用后遮罩显示');
    ok(els['#cd-num'].textContent === '90' && els['#cd-text-a'].textContent === '请在电视上打开' && els['#cd-text-b'].textContent === '「无线调试」开关',
      '初始秒数就位，文案是「引导行 + 重点行」两行');
    ok(typeof beat === 'function', '遮罩自己注册 1 秒心跳（不靠外部喂 tick）');
    beat(); beat(); beat();
    ok(els['#cd-num'].textContent === '87', '心跳独立走表：三次后 90 → 87，探测再慢也不定格');
    ok(Math.abs(+els['#cd-bar'].style.strokeDashoffset - 339.29 * (1 - 87 / 90)) < 0.01, '圆环与秒数同步消退');
    const appSrc2 = rd('js/app.js');
    ok(!appSrc2.includes('ctl.tick('), '等待循环不再驱动秒数：显示与探测已解耦');
    ok(appSrc2.includes('setTimeout(r, 2000)') && appSrc2.includes('if (!busy)'), '探测节奏 2 秒且有在途保护');
    els['#cd-cancel'].onclick();
    ok(cancelled === true, '取消按钮有出口，不会把人锁在屏幕上');
    ctl.close();
    ok(els['#pair-countdown'].hidden === true && cleared > 0, '结束后遮罩收起且心跳停止');
  }

  // ── 无线配对 sidecar：容器有 Node 才有这三个接口，桌面版必须 404（否则前端给出死按钮）──
  console.log('\n[配对 sidecar 能力门控]');
  {
    const files = ['pair/daemon.js', 'pair/api.js', 'pair/index.js', 'pair/mdns.js', 'pair/keystore.js'];
    for (const f of files) {
      const abs = path.resolve(process.cwd(), f);
      ok(fs.existsSync(abs), `真源在共享仓：${f} 存在`);
    }
    const go = fs.readFileSync(path.resolve(process.cwd(), 'bridge.go'), 'utf8');
    const py = fs.readFileSync(path.resolve(process.cwd(), 'pairproxy.go'), 'utf8');
    ok(go.includes('sidecar != nil && (r.URL.Path == \"/pair\"'), 'Go 路由只在 sidecar 存在时接管三接口');
    ok(py.includes('exec.LookPath(node)') && py.includes('os.Stat(script)'), 'Node 或 daemon 缺失 → 能力关闭而非报错');
    ok(!py.includes('http.Client{Timeout: 0'), '转发有硬超时，不会挂住');

    // 块内专用 HTTP 助手，避免与外层同名符号相互干扰
    const req1 = (port, p, method = 'GET', payload) => new Promise((res) => {
      const body = payload ? JSON.stringify(payload) : null;
      const rq = http.request({ host: '127.0.0.1', port, path: p, method, headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {} },
        (rs) => { let b = ''; rs.on('data', (c) => (b += c)); rs.on('end', () => res({ code: rs.statusCode, body: b })); });
      rq.on('error', (e) => res({ code: 'ERR:' + e.code, body: '' }));
      if (body) rq.write(body);
      rq.end();
    });
    // 桌面实例（未设 sidecar 环境变量）：三接口必须 404
    for (const p of ['/discover', '/pair', '/recover']) {
      const r = await req1(P_DESKTOP, p, p === '/pair' || p === '/recover' ? 'POST' : 'GET', p === '/discover' ? null : { host: '192.168.66.122', pairPort: 40217, code: '123456' });
      ok(r.code === 404, `桌面版 ${p} → 404（前端据此隐藏配对入口，不给死按钮）[实测 ${r.code}]`);
    }

    // 再起一个带 sidecar 的实例，模拟容器形态
    const base = 20000 + (process.pid % 4000);
    const pairPort = base, apiPort = base + 1;
    const child = spawn(SERVER, [], {
      env: Object.assign({}, process.env, {
        BRIDGE_HOST: '127.0.0.1', BRIDGE_PORT: String(apiPort), BRIDGE_HTTPS_PORT: '0',
        BRIDGE_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'boxadb-pair-')),
        BOXADB_PAIR_PORT: String(pairPort),
        BOXADB_PAIR_DAEMON: path.join(__dirnameOf(), '..', 'pair', 'daemon.js'),
        NODE_NO_WARNINGS: '1',
      }), stdio: ['ignore', 'pipe', 'pipe'],
    });
    procs.push(child);
    await new Promise((r) => setTimeout(r, 2500));
    const d = await req1(apiPort, '/discover');
    // 反代必须保留 query：丢了 ?host= 的话，「能不能发现」会退化成恒真，按钮该藏也不藏
    const q1 = await req1(apiPort, '/discover?host=203.0.113.9');
    ok(/"discoverable":false/.test(q1.body), `反代保留 query：异网段目标判为不可发现 [${String(q1.body).slice(0, 24)}]`);
    // 用本机真实网段的另一个地址来验证「同段=可发现」（回环属 internal，本来就不算可发现）
    // 同网段判据：取本机任一非内部网口的 /24，造一个同段地址（/16 也必然落在同段内）
    const lan = (() => {
      for (const addrs of Object.values(os.networkInterfaces())) {
        for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) return a.address.split('.').slice(0, 3).join('.') + '.9';
      }
      return null;
    })();
    if (lan) {
      const q2 = await req1(apiPort, '/discover?host=' + encodeURIComponent(lan));
      ok(/"discoverable":true/.test(q2.body), `同网段目标（${lan}）判为可发现，按钮不会被误藏`);
    } else {
      ok(false, '本机无非内部 IPv4 网口，无法验证同网段判据');
    }
    {
      const px = rd('pairproxy.go'), dj = rd('pair/daemon.js');
      ok(px.includes('BOXADB_PAIR_NONCE=') && px.includes('waitReady') && px.includes('判定为陈旧进程'),
        '桥会验明 sidecar 身份：端口上残留的旧进程不会被误当成本次能力');
      ok(px.includes('cmd.Stdin = pr') && dj.includes("process.stdin.on('end'"),
        '桥被强杀时 sidecar 靠 stdin EOF 自退，不留孤儿进程');
    }
    ok(d.code === 200 && /"connect":\[/.test(d.body), `容器形态 /discover 经 Go 转发到 sidecar → ${d.code} ${String(d.body).slice(0, 40)}`);
    const badc = await req1(apiPort, '/pair', 'POST', { host: '192.168.66.122', pairPort: 40217, code: '12' });
    ok(badc.code === 400 && /6 位数字/.test(badc.body), '校验在共享模块里，两个宿主话术一致');
    const badh = await req1(apiPort, '/pair', 'POST', { host: '8.8.8.8', pairPort: 1, code: '123456' });
    ok(badh.code === 400 && /bad-host/.test(badh.body), '公网目标一律拒绝（sidecar 也守同一条线）');
  }


  // ── 自动填端口按钮：只在「本机确实能发现该网段广播」时出现 ──
  console.log('\n[自动填端口 · 环境自适应]');
  {
    const srcApp = rd('js/app.js');
    const i0 = srcApp.indexOf('async function showPortDialog(');
    let dep = 0, i1 = -1;
    for (let k = srcApp.indexOf('{', i0); k < srcApp.length; k++) { if (srcApp[k] === '{') dep++; else if (srcApp[k] === '}' && --dep === 0) { i1 = k; break; } }
    ok(i0 > 0 && i1 > i0, '能取出 showPortDialog 全体');
    const body = srcApp.slice(i0, i1 + 1);
    const AF = Object.getPrototypeOf(async function () {}).constructor;
    const runDialog = async (canPair, disc) => {
      const els = {};
      const mk = () => ({ hidden: true, value: '', textContent: '', innerHTML: '', onclick: null, focus() {}, scrollIntoView() {} });
      for (const k of ['#port-modal', '#port-title', '#port-desc', '#port-input', '#port-modal-ip', '#port-ok', '#port-cancel',
        '#pair-port-input', '#pair-code-input', '#pair-group', '#port-detect', '#pair-note', '#port-stall', '#pair-allow']) els[k] = mk();
      const $d = (x) => els[x];
      const outer = new AF('$', 'toast', 'pairAvailable', 'tango', 'state', 'lastRecover', body + ';return showPortDialog;');
      const fn = await outer($d, () => {}, async () => canPair, async () => ({ discoverWireless: async () => disc }), { ip: '192.168.66.122', prefs: {} }, null);
      await fn('192.168.66.122', 'NEED_PORT');
      return els;
    };
    const e1 = await runDialog(true, { discoverable: true, connect: [], pairing: [], lastPort: null });
    ok(e1['#port-detect'].hidden === false, '能发现广播（NAS / host 网络）→ 显示「自动填端口」');
    const e2 = await runDialog(true, { discoverable: false, lastPort: 42535, connect: [], pairing: [] });
    ok(e2['#port-detect'].hidden === false, '发现不了（网络隔离）→ 按钮照样显示');
    ok(e2['#port-input'].value === '42535', '发现不了时 → 预填上次用过的连接端口');
    const e3 = await runDialog(false, null);
    ok(e3['#port-detect'].hidden === true && e3['#pair-group'].hidden === true, '桥不支持配对 → 按钮与配对区都不出现');
    ok(rd('js/tango.js').includes("api('/discover' + (host ? '?host='"), 'discover 带 host 参数（判据需要目标网段）');
  }


  // ── 日志提示的 https 地址必须是用户真能打开的那个 ──
  console.log('\n[启动提示地址选择]');
  {
    const tlsSrc = rd('tls.go');
    ok(tlsSrc.includes('func lanRank') && tlsSrc.includes('func ifaceNameRank'), '按网段 + 网卡名双重排序（Docker/虚拟网卡排后）');
    const hintLine = spawned.map((r) => (r.out || '').split('\n').find((l) => l.includes('手机/其他设备请用'))).find(Boolean);
    const hintIP = hintLine ? (hintLine.match(/https:\/\/([^:/]+):/) || [])[1] : null;
    // 按「网卡名是否虚拟」判定，而不是靠网段猜：链路本地(169.254)、docker0、
    // bridge100、vmnet 都可能与真实 LAN 同前缀，猜网段必然随接口顺序漂。
    const real = [];
    for (const [dev, addrs] of Object.entries(os.networkInterfaces())) {
      if (/^(br-|bridge|veth|docker|vmnet|utun|awdl|llw|tun|tap|lo|gif|stf)/i.test(dev)) continue;
      for (const a of addrs || []) {
        if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) real.push([dev, a.address]);
      }
    }
    const hit = real.find(([, ip]) => ip === hintIP);
    if (real.length) ok(!!hit, `提示的 ${hintIP || '(无地址)'} 落在真实物理网卡上（候选 ${real.map(([d, i]) => d + '=' + i).join(', ')}）`);
    else ok(false, '本机没有可判定的物理网卡地址，用例无法成立');
  }

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
} catch (e) {
  console.log('测试异常：' + e.message);
  process.exitCode = 1;
} finally {
  procs.forEach(p => { try { p.kill('SIGTERM'); } catch {} });
  process.exit(process.exitCode || (fail ? 1 : 0));
}
