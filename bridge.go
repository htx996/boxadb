// 盒子助手 · 桌面桥（MIT License. Copyright (c) 2026 wukongdaily）
//
// 职责：在"GitHub Pages 上的网页(https)"与"局域网里的电视盒子(TCP)"之间
// 建一条字节管道。浏览器端因 https 混合内容限制不能直连 ws://，
// 所以由本程序在本机 127.0.0.1 起一个小服务代为转发。
//
// 本程序不解析 ADB 协议——ADB 全部由浏览器端的 MIT 引擎（Tango）完成，
// 这里只做两件事：
//  1. GET /health       —— 探活；
//  2. GET /adb?host=&port= —— 升级为 WebSocket(RFC 6455, IETF 公开规范)，
//     并与目标 TCP 地址互搬字节。
package main

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
)

// ── 配置 ──

// 桌面形态默认只监听回环；Docker/NAS 形态用 BRIDGE_HOST=0.0.0.0 对外提供服务。
func listenHost() string {
	if h := os.Getenv("BRIDGE_HOST"); h != "" {
		return h
	}
	return "127.0.0.1"
}

const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// 是否因收到信号而关闭：区分「正常停止」与启动失败
var stopping atomic.Bool

func listenPort() string {
	if p := os.Getenv("BRIDGE_PORT"); p != "" {
		return p
	}
	return "8765"
}

// ── WebSocket 帧（按 RFC 6455；服务端发出的帧不加掩码）──

const (
	opCont  = 0x0
	opText  = 0x1
	opBin   = 0x2
	opClose = 0x8
	opPing  = 0x9
	opPong  = 0xa
)

func putFrame(w io.Writer, opcode byte, data []byte) error {
	var head []byte
	n := len(data)
	switch {
	case n < 126:
		head = []byte{0x80 | opcode, byte(n)}
	case n <= 0xffff:
		head = []byte{0x80 | opcode, 126, byte(n >> 8), byte(n)}
	default:
		head = make([]byte, 10)
		head[0] = 0x80 | opcode
		head[1] = 127
		for i := 0; i < 8; i++ {
			head[2+i] = byte(uint64(n) >> uint(8*(7-i)))
		}
	}
	if _, err := w.Write(head); err != nil {
		return err
	}
	if n > 0 {
		if _, err := w.Write(data); err != nil {
			return err
		}
	}
	return nil
}

func putClose(w io.Writer, code uint16, text string) error {
	body := []byte(text)
	if len(body) > 120 {
		body = body[:120]
	}
	payload := make([]byte, 2+len(body))
	payload[0] = byte(code >> 8)
	payload[1] = byte(code)
	copy(payload[2:], body)
	return putFrame(w, opClose, payload)
}

// grabFrame 读取并解开一个客户端帧（客户端帧必须带掩码）。
// 返回 opcode、载荷，以及该帧之后留在缓冲里的剩余字节。
func grabFrame(br *bufio.Reader) (byte, []byte, error) {
	var hdr [2]byte
	if _, err := io.ReadFull(br, hdr[:]); err != nil {
		return 0, nil, err
	}
	opcode := hdr[0] & 0x0f
	masked := hdr[1]&0x80 != 0
	length := uint64(hdr[1] & 0x7f)
	switch hdr[1] & 0x7f {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(br, ext[:]); err != nil {
			return 0, nil, err
		}
		length = uint64(ext[0])<<8 | uint64(ext[1])
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(br, ext[:]); err != nil {
			return 0, nil, err
		}
		for _, b := range ext {
			length = length<<8 | uint64(b)
		}
	}
	if length > 64<<20 {
		return 0, nil, fmt.Errorf("frame too large: %d", length)
	}
	var mask [4]byte
	if masked {
		if _, err := io.ReadFull(br, mask[:]); err != nil {
			return 0, nil, err
		}
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(br, payload); err != nil {
		return 0, nil, err
	}
	if masked {
		for i := range payload {
			payload[i] ^= mask[i%4]
		}
	}
	return opcode, payload, nil
}

// ── 隧道 ──

func pumpBoth(browser net.Conn, box net.Conn) {
	// 盒子 → 浏览器：每个 TCP 分片包成一个 binary 帧
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, err := box.Read(buf)
			if n > 0 {
				if e := putFrame(browser, opBin, buf[:n]); e != nil {
					break
				}
			}
			if err != nil {
				break
			}
		}
		putClose(browser, 1000, "upstream closed")
		browser.Close()
	}()

	// 浏览器 → 盒子：解帧；收到 close 则双向关闭
	br := bufio.NewReader(browser)
	for {
		op, payload, err := grabFrame(br)
		if err != nil {
			break
		}
		switch op {
		case opBin, opText, opCont:
			if _, e := box.Write(payload); e != nil {
				putClose(browser, 1000, "upstream error")
				box.Close()
				browser.Close()
				return
			}
		case opPing:
			putFrame(browser, opPong, payload)
		case opPong:
			// 忽略
		case opClose:
			putClose(browser, 1000, "")
			box.Close()
			browser.Close()
			return
		}
	}
	box.Close()
	browser.Close()
}

func handleTunnel(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	host := q.Get("host")
	port, err := strconv.Atoi(q.Get("port"))
	if err != nil || port < 1 || port > 65535 || !isIPv4(host) {
		http.Error(w, "bad host/port", http.StatusBadRequest)
		return
	}
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") || r.Header.Get("Sec-WebSocket-Key") == "" {
		http.Error(w, "websocket upgrade required", http.StatusBadRequest)
		return
	}
	if !targetAllowed(host) {
		http.Error(w, "目标地址被拒绝：只允许局域网/VPN 私网地址（如需连公网地址，请设 BRIDGE_PRIVATE_ONLY=0）", http.StatusForbidden)
		return
	}

	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijack unsupported", http.StatusInternalServerError)
		return
	}
	box, err := net.DialTimeout("tcp", net.JoinHostPort(host, strconv.Itoa(port)), 3*time.Second)
	if err != nil {
		http.Error(w, "cannot reach "+host+":"+q.Get("port"), http.StatusBadGateway)
		return
	}
	box.(*net.TCPConn).SetNoDelay(true)

	browser, rw, err := hijacker.Hijack()
	if err != nil {
		box.Close()
		return
	}
	accept := sha1.Sum([]byte(r.Header.Get("Sec-WebSocket-Key") + wsGUID))
	browser.Write([]byte(
		"HTTP/1.1 101 Switching Protocols\r\n" +
			"Upgrade: websocket\r\nConnection: Upgrade\r\n" +
			"Sec-WebSocket-Accept: " + base64.StdEncoding.EncodeToString(accept[:]) + "\r\n\r\n"))
	_ = rw.Flush()
	log.Printf("tunnel open %s:%d", host, port)
	pumpBoth(browser, box)
	log.Printf("tunnel close %s:%d", host, port)
}

// ── HTTP 入口 ──

func allowCross(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "*")
	// GitHub Pages(https) 调 ws://127.0.0.1 的 PNA 预检
	w.Header().Set("Access-Control-Allow-Private-Network", "true")
}

func router(w http.ResponseWriter, r *http.Request) {
	allowCross(w)
	// http 侧把非本机地址的页面请求跳到内置 https（安全上下文，手机才能用）
	if r.TLS == nil {
		if h := httpsRedirectHost(r); h != "" {
			http.Redirect(w, r, redirectTarget(r, h), http.StatusFound)
			return
		}
	}
	switch {
	case r.Method == http.MethodOptions:
		w.WriteHeader(http.StatusNoContent)
	case r.URL.Path == "/health":
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Write([]byte("boxadb bridge ok\n"))
	case r.URL.Path == "/adb":
		handleTunnel(w, r)
	default:
		if static := staticHandler(); static != nil {
			static.ServeHTTP(w, r) // 自托管形态：网页由本进程发出
			return
		}
		http.NotFound(w, r)
	}
}

// 隧道目标白名单：防常驻服务被当通用内网代理（SSRF）
func privateOnlyOn() bool {
	if v := os.Getenv("BRIDGE_PRIVATE_ONLY"); v != "" {
		return v == "1" || strings.EqualFold(v, "true")
	}
	return privateOnlyDefault()
}

func targetAllowed(host string) bool {
	if !privateOnlyOn() {
		return true
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	return ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || isCGNAT(ip)
}

// 100.64.0.0/10 为 Tailscale 等 CGNAT 段，走 VPN 连远端盒子需放行
func isCGNAT(ip net.IP) bool {
	_, net100, err := net.ParseCIDR("100.64.0.0/10")
	return err == nil && net100.Contains(ip)
}

func isIPv4(s string) bool {
	ip := net.ParseIP(s)
	return ip != nil && ip.To4() != nil && strings.Count(s, ".") == 3
}

// ── 启动 ──

// 容器 HEALTHCHECK：scratch 里没有 shell/curl，用本程序自探 /health，失败非 0
func healthCheck() int {
	addr := net.JoinHostPort(listenHost(), listenPort())
	if listenHost() == "0.0.0.0" || listenHost() == "::" || listenHost() == "" {
		addr = net.JoinHostPort("127.0.0.1", listenPort()) // 对外监听时自己走回环探
	}
	c := &http.Client{Timeout: 3 * time.Second}
	resp, err := c.Get("http://" + addr + "/health")
	if err != nil {
		log.Printf("healthcheck 失败: %v", err)
		return 1
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusOK {
		log.Printf("healthcheck 状态码 %d", resp.StatusCode)
		return 1
	}
	return 0
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "-healthcheck" {
		os.Exit(healthCheck())
	}
	addr := net.JoinHostPort(listenHost(), listenPort())

	// 幂等保护：已有一个桥在监听时直接退出（重复双击图标无害）
	if c, err := net.DialTimeout("tcp", addr, 300*time.Millisecond); err == nil {
		c.Close()
		log.Printf("boxadb bridge already running at %s", addr)
		return
	}

	srv := &http.Server{Addr: addr, Handler: http.HandlerFunc(router)}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("listen %s: %v", addr, err)
	}
	mode := "本机桥（网页请用 GitHub Pages）"
	if staticHandler() != nil {
		mode = "自托管：网页 + 桥同源"
	}
	log.Printf("boxadb bridge listening on http://%s  [%s]", addr, mode)
	log.Printf("  health: /health   tunnel: /adb?host=&port=   仅私网目标=%v", privateOnlyOn())

	stop := make(chan struct{})
	if p := httpsPort(); p != "" {
		go serveHTTPS(http.HandlerFunc(router), stop)
		log.Printf("  手机/其他设备请用 %s（局域网 http 地址会被自动引导到 https）", httpsURLHint())
	} else {
		log.Printf("  https 已关闭（BRIDGE_HTTPS_PORT=0）；手机等非 localhost 访问将无法生成密钥")
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sig
		log.Println("shutting down")
		stopping.Store(true)
		close(stop)
		srv.Close()
		ln.Close()
	}()
	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		// 信号关闭会让 Serve 报 use of closed network connection，属正常停止，
		// 不能当致命错误（否则 docker stop 退出码为 1）
		if stopping.Load() {
			log.Println("已停止")
			return
		}
		log.Fatalf("serve: %v", err)
	}
}
