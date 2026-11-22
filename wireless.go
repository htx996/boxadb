package main

// 无线调试（Android 11+ 配对）支持：桥不自己实现 SPAKE2/TLS-PSK，
// 而是调用随包内置的官方 adb 完成「配对 → 连上无线调试端口 → tcpip 5555 固定端口」。
// 之后浏览器端的 Tango 照常连 5555（首次会弹一次「允许 USB 调试」）。
//
// 端点（均在反代前缀下，仅自托管形态可用）：
//   GET  /wireless/discover  列出 mDNS 发现的无线调试设备（配对端口 / 连接端口）
//   POST /wireless/pair      {host,pairPort,code,connPort?} 配对并固定 5555
//   POST /wireless/ensure    {host} 盒子重启后端口变了，用已配对凭据重新固定 5555

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

var adbMu sync.Mutex // adb 是单例服务，所有调用串行

// adb 自己的 server 端口与桌面上的 adb 隔离，避免互相干扰
const adbServerPort = "5038"

// ── 路径与环境 ─────────────────────────────────────────

func dataDir() string {
	if d := os.Getenv("BRIDGE_STATE_DIR"); d != "" {
		return d
	}
	if d := os.Getenv("UGAPP_DATA_DIR"); d != "" {
		return d
	}
	if d, err := os.UserCacheDir(); err == nil {
		return filepath.Join(d, "boxadb")
	}
	return os.TempDir()
}

// adb 与桥同目录（UPK: rootfs_amd64/bin/adb），可用 BRIDGE_ADB 覆盖
func adbBin() string {
	if p := os.Getenv("BRIDGE_ADB"); p != "" {
		return p
	}
	if exe, err := os.Executable(); err == nil {
		p := filepath.Join(filepath.Dir(exe), "adb")
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	return "adb"
}

// 独立的 HOME：adb 密钥（adbkey）落在应用数据目录，不碰系统任何位置
func adbHome() (string, error) {
	home := filepath.Join(dataDir(), "adbhome")
	if err := os.MkdirAll(filepath.Join(home, ".android"), 0o700); err != nil {
		return "", err
	}
	return home, nil
}

func runAdb(timeout time.Duration, args ...string) (string, error) {
	home, err := adbHome()
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, adbBin(), args...)
	cmd.Env = append(os.Environ(),
		"HOME="+home,
		"ANDROID_USER_HOME="+filepath.Join(home, ".android"),
		"ANDROID_ADB_SERVER_PORT="+adbServerPort,
	)
	out, err := cmd.CombinedOutput()
	text := strings.TrimSpace(string(out))
	if len(text) > 2048 {
		text = text[len(text)-2048:]
	}
	if err != nil && text == "" {
		text = err.Error()
	}
	return text, err
}

// ── mDNS 发现 ──────────────────────────────────────────

type wirelessDevice struct {
	Instance    string `json:"instance"`
	Host        string `json:"host"`
	PairPort    int    `json:"pairPort,omitempty"`
	ConnectPort int    `json:"connectPort,omitempty"`
}

// adb mdns services 输出示例：
//
//	List of discovered mdns services
//	adb-44071FDH2003CX	_adb-tls-pairing._tcp.	192.168.66.172:37123
//	adb-44071FDH2003CX	_adb-tls-connect._tcp.	192.168.66.172:38451
func parseMdnsServices(out string) []wirelessDevice {
	byKey := map[string]*wirelessDevice{}
	order := []string{}
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) < 3 {
			continue
		}
		addr := fields[len(fields)-1]
		host, portText, ok := strings.Cut(addr, ":")
		if !ok {
			continue
		}
		port, err := strconv.Atoi(portText)
		if err != nil || !isIPv4(host) {
			continue
		}
		service := strings.ToLower(strings.Join(fields[1:len(fields)-1], " "))
		key := fields[0] + "|" + host
		d, seen := byKey[key]
		if !seen {
			d = &wirelessDevice{Instance: fields[0], Host: host}
			byKey[key] = d
			order = append(order, key)
		}
		switch {
		case strings.Contains(service, "_adb-tls-pairing"):
			d.PairPort = port
		case strings.Contains(service, "_adb-tls-connect"):
			d.ConnectPort = port
		}
	}
	list := make([]wirelessDevice, 0, len(order))
	for _, k := range order {
		list = append(list, *byKey[k])
	}
	return list
}

func discoverWireless() ([]wirelessDevice, string, bool) {
	out, _ := runAdb(10*time.Second, "mdns", "services")
	ok := strings.Contains(out, "List of discovered mdns services")
	return parseMdnsServices(out), out, ok
}

// ── 连通性 ─────────────────────────────────────────────

func tcpReachable(host string, port int, timeout time.Duration) bool {
	c, err := net.DialTimeout("tcp", net.JoinHostPort(host, strconv.Itoa(port)), timeout)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

var pairedRe = regexp.MustCompile(`(?i)successfully paired to .*\[guid=([^\]]+)\]`)

// ── HTTP 端点 ──────────────────────────────────────────

type adbStep struct {
	Name   string `json:"name"`
	OK     bool   `json:"ok"`
	Output string `json:"output"`
}

type wirelessResp struct {
	OK       bool             `json:"ok"`
	Message  string           `json:"message,omitempty"`
	Hint     string           `json:"hint,omitempty"`
	Need     string           `json:"need,omitempty"`
	Host     string           `json:"host,omitempty"`
	Port     int              `json:"port,omitempty"`
	Instance string           `json:"instance,omitempty"`
	Already  bool             `json:"already,omitempty"`
	Devices  []wirelessDevice `json:"devices,omitempty"`
	Steps    []adbStep        `json:"steps,omitempty"`
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(v)
}

func handleWirelessDiscover(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" && r.Method != "POST" {
		w.WriteHeader(405)
		return
	}
	adbMu.Lock()
	devices, raw, ok := discoverWireless()
	adbMu.Unlock()
	resp := wirelessResp{OK: true, Devices: devices}
	if !ok {
		// adb 缺失 / 起不来：把原始输出带回去，方便排查
		resp.OK = false
		resp.Message = "内置 adb 不可用"
		resp.Hint = "打包时应把 adb 放在桥同目录（bin/adb）；也可用 BRIDGE_ADB 指定路径"
		resp.Steps = []adbStep{{Name: "adb mdns services", OK: false, Output: raw}}
	} else if len(devices) == 0 {
		resp.Message = "没有发现正在广播的设备"
		resp.Hint = "确认电视上「无线调试」已打开（盒子重启后会自动关掉），或直接手填配对端口和配对码"
	}
	writeJSON(w, resp)
}

type pairRequest struct {
	Host     string `json:"host"`
	PairPort int    `json:"pairPort"`
	Code     string `json:"code"`
	ConnPort int    `json:"connPort"`
}

func handleWirelessPair(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		w.WriteHeader(405)
		return
	}
	var req pairRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, wirelessResp{OK: false, Message: "请求格式不正确"})
		return
	}
	req.Host = strings.TrimSpace(req.Host)
	req.Code = strings.TrimSpace(req.Code)
	if !isIPv4(req.Host) || !targetAllowed(req.Host) {
		writeJSON(w, wirelessResp{OK: false, Message: "目标地址必须是局域网内的盒子 IPv4"})
		return
	}
	if req.PairPort < 1 || req.PairPort > 65535 {
		writeJSON(w, wirelessResp{OK: false, Message: "配对端口请填 1-65535 的数字"})
		return
	}
	if !regexp.MustCompile(`^\d{6}$`).MatchString(req.Code) {
		writeJSON(w, wirelessResp{OK: false, Message: "配对码是 6 位数字（电视配对窗口上那串）"})
		return
	}

	adbMu.Lock()
	defer adbMu.Unlock()

	steps := []adbStep{}
	pairAddr := net.JoinHostPort(req.Host, strconv.Itoa(req.PairPort))
	pairOut, _ := runAdb(60*time.Second, "pair", pairAddr, req.Code)
	paired := strings.Contains(strings.ToLower(pairOut), "successfully paired")
	steps = append(steps, adbStep{Name: "配对 " + pairAddr, OK: paired, Output: pairOut})
	if !paired {
		hint := "配对中断，请确认配对窗口仍停留在电视上，配对码没过期"
		if strings.Contains(strings.ToLower(pairOut), "refused") || strings.Contains(strings.ToLower(pairOut), "timed out") {
			hint = "连不上配对端口，请确认配对窗口是打开状态、端口没填错"
		}
		writeJSON(w, wirelessResp{OK: false, Message: "配对失败", Hint: hint, Steps: steps})
		return
	}

	instance := ""
	if m := pairedRe.FindStringSubmatch(pairOut); len(m) == 2 {
		instance = m[1]
	}

	// 连接端口：优先用户填的，否则按 guid 从 mDNS 里配对
	connPort := req.ConnPort
	if connPort == 0 {
		devices, _, _ := discoverWireless()
		for _, d := range devices {
			if d.Host != req.Host || d.ConnectPort == 0 {
				continue
			}
			if instance == "" || d.Instance == instance {
				connPort = d.ConnectPort
				break
			}
		}
	}
	if connPort == 0 {
		writeJSON(w, wirelessResp{OK: false, Message: "已配对成功，但没查到连接端口", Need: "conn-port",
			Hint: "把电视「无线调试」第一屏显示的那串 IP:端口里的端口填到「连接端口」再来一次", Steps: steps})
		return
	}

	serial := net.JoinHostPort(req.Host, strconv.Itoa(connPort))
	connOut, _ := runAdb(25*time.Second, "connect", serial)
	connected := strings.Contains(strings.ToLower(connOut), "connected to") || strings.Contains(strings.ToLower(connOut), "already connected")
	steps = append(steps, adbStep{Name: "连接 " + serial, OK: connected, Output: connOut})
	if !connected {
		writeJSON(w, wirelessResp{OK: false, Message: "配对成功，但连接无线调试端口失败", Steps: steps,
			Hint: "请照电视「无线调试」第一屏核对端口号；配对码页面填的端口不是连接端口"})
		return
	}

	pinOut, _ := runAdb(20*time.Second, "-s", serial, "tcpip", "5555")
	pinned := strings.Contains(strings.ToLower(pinOut), "restarting in tcp mode") || strings.Contains(pinOut, "5555")
	steps = append(steps, adbStep{Name: "固定端口 tcpip 5555", OK: pinned, Output: pinOut})

	// adbd 重启需要一点时间，最多等 3 秒
	reachable := false
	for i := 0; i < 6 && !reachable; i++ {
		time.Sleep(500 * time.Millisecond)
		reachable = tcpReachable(req.Host, 5555, time.Second)
	}
	steps = append(steps, adbStep{Name: "检查 5555", OK: reachable,
		Output: map[bool]string{true: "5555 已可连接", false: "5555 暂不可连接"}[reachable]})

	resp := wirelessResp{OK: reachable, Host: req.Host, Port: 5555, Instance: instance, Steps: steps}
	if reachable {
		resp.Message = "配对成功，已固定到 5555"
		resp.Hint = "回到上面点「连接」即可；第一次电视会弹「允许 USB 调试」，用遥控器点允许"
	} else {
		resp.Message = "配对成功，但 5555 还没起来"
		resp.Hint = "等两秒再点一次「修复连接」，或者确认盒子上没有禁用 adb tcpip"
	}
	writeJSON(w, resp)
}

type ensureRequest struct {
	Host string `json:"host"`
}

// 盒子重启后无线调试端口会变：用已配对的凭据重新连上并把端口固定回 5555
func handleWirelessEnsure(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		w.WriteHeader(405)
		return
	}
	var req ensureRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, wirelessResp{OK: false, Message: "请求格式不正确"})
		return
	}
	req.Host = strings.TrimSpace(req.Host)
	if !isIPv4(req.Host) || !targetAllowed(req.Host) {
		writeJSON(w, wirelessResp{OK: false, Message: "目标地址必须是局域网内的盒子 IPv4"})
		return
	}

	adbMu.Lock()
	defer adbMu.Unlock()

	if tcpReachable(req.Host, 5555, 2*time.Second) {
		writeJSON(w, wirelessResp{OK: true, Already: true, Host: req.Host, Port: 5555, Message: "5555 本来就通，无需修复"})
		return
	}

	steps := []adbStep{}
	devices, _, _ := discoverWireless()
	port := 0
	for _, d := range devices {
		if d.Host == req.Host && d.ConnectPort != 0 {
			port = d.ConnectPort
			break
		}
	}
	if port == 0 {
		writeJSON(w, wirelessResp{OK: false, Message: "没查到无线调试广播", Need: "manual-port", Steps: steps,
			Hint: "盒子重启后「无线调试」会自动关掉：用遥控器重新打开（不用再输配对码），再点一次修复"})
		return
	}

	serial := net.JoinHostPort(req.Host, strconv.Itoa(port))
	connOut, _ := runAdb(25*time.Second, "connect", serial)
	connected := strings.Contains(strings.ToLower(connOut), "connected to") || strings.Contains(strings.ToLower(connOut), "already connected")
	steps = append(steps, adbStep{Name: "连接 " + serial, OK: connected, Output: connOut})
	if !connected {
		writeJSON(w, wirelessResp{OK: false, Message: "连不上无线调试端口", Need: "pair", Steps: steps,
			Hint: "这台设备可能需要重新配对一次（电视上重新点「使用配对码配对设备」）"})
		return
	}

	pinOut, _ := runAdb(20*time.Second, "-s", serial, "tcpip", "5555")
	pinned := strings.Contains(strings.ToLower(pinOut), "restarting in tcp mode")
	steps = append(steps, adbStep{Name: "固定端口 tcpip 5555", OK: pinned, Output: pinOut})

	reachable := false
	for i := 0; i < 6 && !reachable; i++ {
		time.Sleep(500 * time.Millisecond)
		reachable = tcpReachable(req.Host, 5555, time.Second)
	}
	steps = append(steps, adbStep{Name: "检查 5555", OK: reachable,
		Output: map[bool]string{true: "5555 已可连接", false: "5555 暂不可连接"}[reachable]})

	writeJSON(w, wirelessResp{OK: reachable, Host: req.Host, Port: 5555, Steps: steps,
		Message: map[bool]string{true: "已重新固定到 5555", false: "修复失败"}[reachable],
		Hint:    map[bool]string{true: "", false: "确认盒子在线、无线调试已打开；仍失败就重新配对一次"}[reachable]})
}

func adbShutdown() {
	adbMu.Lock()
	defer adbMu.Unlock()
	_, _ = runAdb(3*time.Second, "kill-server")
}
