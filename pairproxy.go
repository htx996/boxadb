package main

// 无线配对 sidecar：容器镜像里带 Node 运行时时才启用。
// 桌面版没有 Node，这里探测失败即返回 nil，三个路由保持 404 —— 前端靠探测隐藏配对入口，
// 不会给出点了没反应的按钮。
import (
	"crypto/rand"
	"encoding/hex"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"time"
)

type pairSidecar struct {
	base      string
	client    *http.Client
	proc      *exec.Cmd
	stdinPipe *os.File
}

func startPairSidecar() *pairSidecar {
	port := strings.TrimSpace(os.Getenv("BOXADB_PAIR_PORT"))
	if port == "" {
		return nil
	}
	node := os.Getenv("BOXADB_NODE_BIN")
	if node == "" {
		node = "node"
	}
	script := os.Getenv("BOXADB_PAIR_DAEMON")
	if script == "" {
		script = "/app/pair/daemon.js"
	}
	if _, err := exec.LookPath(node); err != nil {
		log.Printf("pair sidecar: 找不到 %s，配对能力关闭", node)
		return nil
	}
	if _, err := os.Stat(script); err != nil {
		log.Printf("pair sidecar: 找不到 %s，配对能力关闭", script)
		return nil
	}
	cmd := exec.Command(node, script)
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		log.Printf("pair sidecar: 随机数生成失败 %v", err)
		return nil
	}
	want := hex.EncodeToString(nonce)
	cmd.Env = append(os.Environ(),
		"BOXADB_PAIR_PORT="+port,
		"BOXADB_STATE_DIR="+os.Getenv("BRIDGE_STATE_DIR"),
		"BOXADB_PAIR_NONCE="+want,
		"NODE_NO_WARNINGS=1",
	)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	s := &pairSidecar{
		base:   "http://127.0.0.1:" + port,
		client: &http.Client{Timeout: 40 * time.Second},
		proc:   cmd,
	}
	// 一根不写入的管道：桥退出（含被 SIGKILL）后读端拿到 EOF，sidecar 自行退出，不留孤儿
	pr, pw, perr := os.Pipe()
	if perr != nil {
		log.Printf("pair sidecar: 管道创建失败 %v，配对能力关闭", perr)
		return nil
	}
	cmd.Stdin = pr
	s.stdinPipe = pw
	if err := cmd.Start(); err != nil {
		log.Printf("pair sidecar: 启动失败 %v", err)
		_ = pw.Close()
		_ = pr.Close()
		return nil
	}
	// 端口上可能残留着上一次被 SIGKILL 后变孤儿的旧 sidecar：验明 nonce 才接管，否则会拿到旧行为
	if !s.waitReady(want) {
		log.Printf("pair sidecar: 未能验明身份（端口 %s 上可能是残留进程），配对能力关闭", port)
		_ = cmd.Process.Kill()
		return nil
	}
	log.Printf("pair sidecar: 已启动 pid=%d at %s", cmd.Process.Pid, s.base)
	go func() {
		if err := cmd.Wait(); err != nil {
			log.Printf("pair sidecar: 退出 %v", err)
		}
	}()
	return s
}

func (s *pairSidecar) waitReady(want string) bool {
	for i := 0; i < 20; i++ {
		resp, err := s.client.Get(s.base + "/health")
		if err == nil {
			b, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if strings.Contains(string(b), want) {
				return true
			}
			log.Printf("pair sidecar: /health 未回显本次 nonce，判定为陈旧进程")
			return false
		}
		time.Sleep(150 * time.Millisecond)
	}
	return false
}

// 只转发这三个固定路径，目标固定是本机回环，不接受任意上游
func (s *pairSidecar) stop() {
	if s == nil {
		return
	}
	if s.stdinPipe != nil {
		_ = s.stdinPipe.Close()   // 让子进程收到 EOF，自己走人
	}
	if s.proc != nil && s.proc.Process != nil {
		_ = s.proc.Process.Kill()
	}
}

func (s *pairSidecar) allowed(p string) bool {
	return p == "/pair" || p == "/recover" || p == "/discover"
}

func (s *pairSidecar) handle(w http.ResponseWriter, r *http.Request) {
	// 必须带上 query：/discover?host= 的判据全靠它
	target, err := url.Parse(s.base + r.URL.Path + "?" + r.URL.RawQuery)
	if err != nil || !s.allowed(r.URL.Path) {
		http.NotFound(w, r)
		return
	}
	if r.Body != nil {
		defer r.Body.Close()
	}
	req, err := http.NewRequestWithContext(r.Context(), r.Method, target.String(), r.Body)
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if ct := r.Header.Get("Content-Type"); ct != "" {
		req.Header.Set("Content-Type", ct)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		log.Printf("pair sidecar 转发失败 %s: %v", r.URL.Path, err)
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusBadGateway)
		io.WriteString(w, `{"error":"sidecar-unreachable","hint":"配对组件没在运行，请重启容器"}`)
		return
	}
	defer resp.Body.Close()
	for k, v := range resp.Header {
		if k == "Content-Length" {
			continue
		}
		for _, x := range v {
			w.Header().Add(k, x)
		}
	}
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}
