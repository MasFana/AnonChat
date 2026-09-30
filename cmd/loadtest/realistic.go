package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os/exec"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type realisticFlags struct {
	rooms, participants, rate, messageBytes, sourceBytes, sourceEvery, serverPID int
	duration, metricsInterval, warmup                                            time.Duration
	senderMode, base                                                             string
}

func (f *realisticFlags) bind() {
	flag.IntVar(&f.participants, "participants", 50, "realistic: participants per room including owner")
	flag.IntVar(&f.rate, "messages-per-room-per-second", 1, "realistic: requested messages per room per second (per user for sender-mode all)")
	flag.IntVar(&f.messageBytes, "message-bytes", 500, "realistic: normal message UTF-8 bytes")
	flag.IntVar(&f.sourceBytes, "source-message-bytes", 0, "realistic: source message UTF-8 bytes; zero disables")
	flag.IntVar(&f.sourceEvery, "source-message-every", 60, "realistic: one source message every N normal messages per room")
	flag.StringVar(&f.senderMode, "sender-mode", "owner", "realistic: owner, round-robin, all")
	flag.DurationVar(&f.metricsInterval, "metrics-interval", time.Second, "realistic: metrics sample interval")
	flag.DurationVar(&f.warmup, "warmup", 10*time.Second, "realistic: connected-stream warmup")
	flag.IntVar(&f.serverPID, "server-pid", 0, "realistic: Windows server process ID")
}

type realisticResult struct {
	mu                                                                    sync.Mutex
	httpLat, deliveryLat                                                  []time.Duration
	requests, errors, attempted, accepted, expected, delivered, connected atomic.Uint64
	status                                                                [6]atomic.Uint64
}
type realisticParticipant struct{ roomID, anon string }
type realisticRoom struct {
	id     string
	people []realisticParticipant
}

func realisticMessage(bytesWanted int, source bool, token string) string {
	prefix := "loadtest-" + token + "-"
	if bytesWanted < len(prefix) {
		return prefix[:bytesWanted]
	}
	seed := "hello = 'anonchat'\nfunction sendMessage(room, text) {\n  return fetch(`/api/room/${room}/message`, { method: 'POST', body: JSON.stringify({ content: text }) })\n}\n"
	if !source {
		seed = "normal chat message from load benchmark. "
	}
	var b strings.Builder
	b.WriteString(prefix)
	for b.Len()+len(seed) <= bytesWanted {
		b.WriteString(seed)
	}
	for b.Len() < bytesWanted {
		b.WriteByte('x')
	}
	return b.String()
}

func scenarioMessagesPerSecond(rate, participants int, mode string) int {
	if mode == "all" {
		return rate * participants
	}
	return rate
}

func runRealistic(base string, f realisticFlags) {
	if f.rooms < 1 || f.participants < 1 || f.rate < 1 || f.duration <= 0 || f.messageBytes < 1 || f.sourceBytes < 0 || f.sourceEvery < 1 || f.metricsInterval <= 0 || f.warmup < 0 || (f.senderMode != "owner" && f.senderMode != "round-robin" && f.senderMode != "all") {
		panic("realistic: invalid parameters")
	}
	base = strings.TrimRight(f.base, "/")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	transport := &http.Transport{MaxIdleConns: 4096, MaxIdleConnsPerHost: 4096, MaxConnsPerHost: 4096, IdleConnTimeout: 90 * time.Second}
	client := &http.Client{Transport: transport}
	defer transport.CloseIdleConnections()
	r := &realisticResult{}
	before := realisticMetrics(ctx, client, base, r)
	resources := startServerSampler(ctx, f.serverPID)
	startWall := time.Now()
	rooms, err := realisticSetup(ctx, client, base, f, r)
	if err != nil {
		fmt.Printf("setup_error=%q\n", err)
		return
	}
	if f.warmup > 0 {
		select {
		case <-time.After(f.warmup):
		case <-ctx.Done():
		}
	}
	measureStart := time.Now()
	deadline := measureStart.Add(f.duration)
	metricsDone := make(chan struct{})
	go func() {
		defer close(metricsDone)
		t := time.NewTicker(f.metricsInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				realisticMetrics(ctx, client, base, r)
			}
		}
	}()
	var sendWG sync.WaitGroup
	for _, rm := range rooms {
		rm := rm
		sendWG.Add(1)
		go func() { defer sendWG.Done(); realisticSend(ctx, client, base, rm, f, deadline, r) }()
	}
	time.Sleep(time.Until(deadline))
	sendWG.Wait()
	// Drain queued frames briefly while streams remain connected.
	time.Sleep(200 * time.Millisecond)
	cancel()
	<-metricsDone
	after := realisticMetrics(context.Background(), client, base, r)
	reportRealistic(f, r, before, after, resources.stop(), time.Since(startWall), time.Since(measureStart))
}

func realisticSetup(ctx context.Context, client *http.Client, base string, f realisticFlags, r *realisticResult) ([]realisticRoom, error) {
	rooms := make([]realisticRoom, 0, f.rooms)
	ready := make(chan bool, f.rooms*f.participants)
	for i := 0; i < f.rooms; i++ {
		rm, err := realisticCreate(ctx, client, base, r)
		if err != nil {
			return nil, err
		}
		people := []realisticParticipant{{rm.id, rm.anon}}
		go realisticSSE(ctx, client, base, people[0], ready, r)
		for p := 1; p < f.participants; p++ {
			anon, err := realisticIdentity(ctx, client, base, r)
			if err != nil {
				return nil, err
			}
			if err = realisticJoin(ctx, client, base, rm.id, anon, r); err != nil {
				return nil, err
			}
			people = append(people, realisticParticipant{rm.id, anon})
			go realisticSSE(ctx, client, base, people[len(people)-1], ready, r)
		}
		rooms = append(rooms, realisticRoom{rm.id, people})
	}
	for range f.rooms * f.participants {
		if !<-ready {
			return nil, fmt.Errorf("SSE snapshot not received")
		}
	}
	return rooms, nil
}

func realisticRequest(ctx context.Context, c *http.Client, method, target string, body io.Reader, r *realisticResult) (*http.Response, error) {
	start := time.Now()
	req, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	r.requests.Add(1)
	res, err := c.Do(req)
	if err != nil {
		r.errors.Add(1)
		return nil, err
	}
	r.status[res.StatusCode/100].Add(1)
	if method != http.MethodGet || !strings.Contains(target, "/sse") {
		r.mu.Lock()
		r.httpLat = append(r.httpLat, time.Since(start))
		r.mu.Unlock()
	}
	return res, nil
}
func realisticIdentity(ctx context.Context, c *http.Client, base string, r *realisticResult) (string, error) {
	res, err := realisticRequest(ctx, c, http.MethodGet, base+"/api/anon", nil, r)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	var v struct {
		AnonID string `json:"anonId"`
	}
	if res.StatusCode != 200 || json.NewDecoder(res.Body).Decode(&v) != nil || v.AnonID == "" {
		return "", fmt.Errorf("identity HTTP %d", res.StatusCode)
	}
	return v.AnonID, nil
}
func realisticCreate(ctx context.Context, c *http.Client, base string, r *realisticResult) (room, error) {
	anon, err := realisticIdentity(ctx, c, base, r)
	if err != nil {
		return room{}, err
	}
	b, _ := json.Marshal(map[string]string{"anonId": anon})
	res, err := realisticRequest(ctx, c, http.MethodPost, base+"/api/room", bytes.NewReader(b), r)
	if err != nil {
		return room{}, err
	}
	defer res.Body.Close()
	var v struct {
		RoomID string `json:"roomId"`
	}
	if res.StatusCode != 200 || json.NewDecoder(res.Body).Decode(&v) != nil || v.RoomID == "" {
		return room{}, fmt.Errorf("create HTTP %d", res.StatusCode)
	}
	return room{v.RoomID, anon}, nil
}
func realisticJoin(ctx context.Context, c *http.Client, base, id, anon string, r *realisticResult) error {
	b, _ := json.Marshal(map[string]string{"anonId": anon})
	res, err := realisticRequest(ctx, c, http.MethodPost, base+"/api/room/"+id+"/join", bytes.NewReader(b), r)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fmt.Errorf("join HTTP %d", res.StatusCode)
	}
	return nil
}

func realisticSSE(ctx context.Context, c *http.Client, base string, p realisticParticipant, ready chan<- bool, r *realisticResult) {
	res, err := realisticRequest(ctx, c, http.MethodGet, base+"/api/room/"+p.roomID+"/sse?anonId="+url.QueryEscape(p.anon), nil, r)
	if err != nil || res.StatusCode != 200 {
		if res != nil {
			res.Body.Close()
		}
		ready <- false
		return
	}
	defer res.Body.Close()
	s := bufio.NewScanner(res.Body)
	s.Buffer(make([]byte, 64<<10), 256<<10)
	sent := false
	for s.Scan() {
		line := s.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var e struct {
			Type    string `json:"type"`
			Payload struct {
				Content string `json:"content"`
			} `json:"payload"`
		}
		if json.Unmarshal([]byte(line[6:]), &e) != nil {
			continue
		}
		if !sent && e.Type == "snapshot" {
			ready <- true
			sent = true
			r.connected.Add(1)
		}
		if strings.HasPrefix(e.Payload.Content, "loadtest-") {
			parts := strings.SplitN(e.Payload.Content, "-", 3)
			if len(parts) > 1 {
				if ns, err := time.ParseDuration(parts[1] + "ns"); err == nil {
					r.delivered.Add(1)
					r.mu.Lock()
					r.deliveryLat = append(r.deliveryLat, time.Since(time.Unix(0, ns.Nanoseconds())))
					r.mu.Unlock()
				}
			}
		}
	}
	if !sent {
		ready <- false
	}
}

func realisticSend(ctx context.Context, c *http.Client, base string, rm realisticRoom, f realisticFlags, deadline time.Time, r *realisticResult) {
	rate := scenarioMessagesPerSecond(f.rate, len(rm.people), f.senderMode)
	tick := time.NewTicker(time.Second / time.Duration(rate))
	defer tick.Stop()
	var n uint64
	for now := range tick.C {
		if !now.Before(deadline) {
			return
		}
		n++
		sender := rm.people[0]
		if f.senderMode == "round-robin" || f.senderMode == "all" {
			sender = rm.people[(n-1)%uint64(len(rm.people))]
		}
		source := f.sourceBytes > 0 && n%uint64(f.sourceEvery) == 0
		size := f.messageBytes
		if source {
			size = f.sourceBytes
		}
		token := fmt.Sprintf("%d-%s-%d", time.Now().UnixNano(), rm.id, n)
		content := realisticMessage(size, source, token)
		body, _ := json.Marshal(map[string]string{"anonId": sender.anon, "content": content})
		r.attempted.Add(1)
		res, err := realisticRequest(ctx, c, http.MethodPost, base+"/api/room/"+rm.id+"/message", bytes.NewReader(body), r)
		if err != nil {
			continue
		}
		io.Copy(io.Discard, res.Body)
		if res.StatusCode == 200 {
			r.accepted.Add(1)
			r.expected.Add(uint64(len(rm.people)))
		}
		res.Body.Close()
	}
}

func realisticMetrics(ctx context.Context, c *http.Client, base string, r *realisticResult) map[string]uint64 {
	res, err := realisticRequest(ctx, c, http.MethodGet, base+"/metrics", nil, r)
	if err != nil {
		return nil
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	v := map[string]uint64{}
	for _, line := range strings.Split(string(b), "\n") {
		var k string
		var n uint64
		if _, err := fmt.Sscan(line, &k, &n); err == nil {
			v[k] = n
		}
	}
	return v
}
func percentileRealistic(v []time.Duration, p int) time.Duration {
	if len(v) == 0 {
		return 0
	}
	sort.Slice(v, func(i, j int) bool { return v[i] < v[j] })
	return v[(len(v)-1)*p/100]
}
func reportRealistic(f realisticFlags, r *realisticResult, before, after map[string]uint64, resource serverResources, wall, measured time.Duration) {
	r.mu.Lock()
	h := append([]time.Duration(nil), r.httpLat...)
	d := append([]time.Duration(nil), r.deliveryLat...)
	r.mu.Unlock()
	kv := func(k string, v any) { fmt.Printf("%s=%v\n", k, v) }
	kv("rooms", f.rooms)
	kv("participants_per_room", f.participants)
	kv("total_participants", f.rooms*f.participants)
	kv("connected_sse", r.connected.Load())
	kv("duration", measured)
	kv("configured_messages_per_second", scenarioMessagesPerSecond(f.rate, f.participants, f.senderMode)*f.rooms)
	kv("attempted_messages", r.attempted.Load())
	kv("accepted_messages", r.accepted.Load())
	kv("rejected_messages_by_http_status", r.status[4].Load()+r.status[5].Load())
	kv("http_request_count", r.requests.Load())
	kv("http_request_errors", r.errors.Load())
	kv("expected_deliveries", r.expected.Load())
	kv("received_deliveries", r.delivered.Load())
	ratio := 0.0
	if r.expected.Load() > 0 {
		ratio = float64(r.delivered.Load()) / float64(r.expected.Load())
	}
	kv("delivery_ratio", ratio)
	for _, x := range []struct {
		name string
		v    []time.Duration
	}{{"end_to_end_delivery_latency", d}, {"http_mutation_latency", h}} {
		for _, p := range []int{50, 95, 99} {
			kv(fmt.Sprintf("%s_p%d", x.name, p), percentileRealistic(x.v, p))
		}
		if len(x.v) > 0 {
			kv(x.name+"_max", percentileRealistic(x.v, 100))
		}
	}
	for k, v := range after {
		kv("server_metrics_delta_"+k, v-before[k])
	}
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	kv("load_generator_heap_alloc_bytes", ms.Alloc)
	kv("load_generator_cpu_time", time.Duration(0))
	kv("elapsed_wall_time", wall)
	resource.report(kv)
}

type resourceRange struct{ min, max, sum float64 }

func (r *resourceRange) add(v float64) {
	if r.sum == 0 || v < r.min {
		r.min = v
	}
	if v > r.max {
		r.max = v
	}
	r.sum += v
}

type serverResources struct {
	unsupported                                bool
	samples                                    int
	cpu, workingSet, private, handles, threads resourceRange
	stop                                       func() serverResources
}

func (s serverResources) report(kv func(string, any)) {
	if s.unsupported {
		kv("server_resource_sampling", "unsupported")
	} else if s.samples == 0 {
		kv("server_resource_sampling", "unavailable")
	} else {
		kv("server_resource_sample_count", s.samples)
		for _, value := range []struct {
			name  string
			value resourceRange
		}{{"cpu_percent", s.cpu}, {"working_set_bytes", s.workingSet}, {"private_memory_bytes", s.private}, {"handles", s.handles}, {"threads", s.threads}} {
			kv("server_resource_"+value.name+"_min", value.value.min)
			kv("server_resource_"+value.name+"_average", value.value.sum/float64(s.samples))
			kv("server_resource_"+value.name+"_max", value.value.max)
		}
	}
}
func startServerSampler(ctx context.Context, pid int) serverResources {
	if pid == 0 || runtime.GOOS != "windows" {
		return serverResources{unsupported: true, stop: func() serverResources { return serverResources{unsupported: true} }}
	}
	var mu sync.Mutex
	var values serverResources
	var previousCPU float64
	var previousAt time.Time
	done := make(chan struct{})
	go func() {
		t := time.NewTicker(time.Second)
		defer t.Stop()
		defer close(done)
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				cmd := exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", fmt.Sprintf("Get-Process -Id %d | Select-Object CPU,WorkingSet64,PrivateMemorySize64,HandleCount,@{Name='ThreadCount';Expression={$_.Threads.Count}} | ConvertTo-Json -Compress", pid))
				out, err := cmd.Output()
				var sample struct {
					CPU, WorkingSet64, PrivateMemorySize64 float64
					HandleCount, ThreadCount               int
				}
				if err == nil && json.Unmarshal(out, &sample) == nil {
					now := time.Now()
					cpu := 0.0
					if !previousAt.IsZero() {
						cpu = 100 * (sample.CPU - previousCPU) / now.Sub(previousAt).Seconds() / float64(runtime.NumCPU())
					}
					previousCPU, previousAt = sample.CPU, now
					mu.Lock()
					values.samples++
					values.cpu.add(cpu)
					values.workingSet.add(sample.WorkingSet64)
					values.private.add(sample.PrivateMemorySize64)
					values.handles.add(float64(sample.HandleCount))
					values.threads.add(float64(sample.ThreadCount))
					mu.Unlock()
				}
			}
		}
	}()
	return serverResources{stop: func() serverResources { <-done; mu.Lock(); defer mu.Unlock(); return values }}
}
