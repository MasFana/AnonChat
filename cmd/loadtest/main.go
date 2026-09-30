package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type result struct {
	mu                                                 sync.Mutex
	httpLat, deliveryLat                               []time.Duration
	requests, networkErrors, sent, expected, delivered atomic.Uint64
	status                                             [6]atomic.Uint64
	metrics                                            atomic.Pointer[metricSample]
}
type metricSample struct{ values map[string]uint64 }
type room struct{ id, anon string }

func main() {
	base := flag.String("base", "http://127.0.0.1:8000", "server URL")
	mode := flag.String("mode", "fanout", "fanout, rooms, churn, realistic")
	clients := flag.Int("clients", 31, "non-owner SSE clients")
	rooms := flag.Int("rooms", 100, "rooms")
	rate := flag.Int("rate", 20, "messages or connects per second")
	duration := flag.Duration("duration", 10*time.Second, "run duration")
	realistic := realisticFlags{}
	realistic.bind()
	flag.Parse()
	realistic.rooms = 10
	realistic.duration = time.Minute
	flag.Visit(func(item *flag.Flag) {
		if item.Name == "rooms" {
			realistic.rooms = *rooms
		}
		if item.Name == "duration" {
			realistic.duration = *duration
		}
	})
	realistic.base = *base
	if *clients < 0 || *rooms < 1 || *rate < 1 || *duration <= 0 {
		panic("clients >= 0, rooms/rate > 0, duration > 0 required")
	}
	if *mode == "realistic" {
		runRealistic(*base, realistic)
		return
	}
	r := &result{}
	client := &http.Client{Transport: &http.Transport{MaxIdleConns: 10000, MaxIdleConnsPerHost: 10000}, Timeout: 10 * time.Second}
	ctx, cancel := context.WithTimeout(context.Background(), *duration+30*time.Second)
	defer cancel()
	*base = strings.TrimRight(*base, "/")
	go sampleMetrics(ctx, client, *base, r)
	switch *mode {
	case "fanout":
		fanout(ctx, client, *base, *clients, *rate, *duration, r)
	case "rooms":
		roomDensity(ctx, client, *base, *rooms, r)
	case "churn":
		churn(ctx, client, *base, *rate, *duration, r)
	default:
		panic("-mode must be fanout, rooms, churn, or realistic")
	}
	report(r)
}

func request(ctx context.Context, client *http.Client, method, target string, body io.Reader, r *result) (*http.Response, error) {
	start := time.Now()
	req, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	r.requests.Add(1)
	res, err := client.Do(req)
	if err != nil {
		r.networkErrors.Add(1)
		return nil, err
	}
	r.status[res.StatusCode/100].Add(1)
	r.mu.Lock()
	r.httpLat = append(r.httpLat, time.Since(start))
	r.mu.Unlock()
	return res, nil
}

func identity(ctx context.Context, client *http.Client, base string, r *result) (string, error) {
	res, err := request(ctx, client, http.MethodGet, base+"/api/anon", nil, r)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("identity: HTTP %d", res.StatusCode)
	}
	var value struct {
		AnonID string `json:"anonId"`
	}
	err = json.NewDecoder(res.Body).Decode(&value)
	if err != nil {
		return "", fmt.Errorf("decode identity response: %w", err)
	}
	if value.AnonID == "" {
		return "", fmt.Errorf("empty identity response")
	}
	return value.AnonID, nil
}
func createRoom(ctx context.Context, client *http.Client, base string, r *result) (room, error) {
	anon, err := identity(ctx, client, base, r)
	if err != nil {
		return room{}, err
	}
	body, _ := json.Marshal(map[string]string{"anonId": anon})
	res, err := request(ctx, client, http.MethodPost, base+"/api/room", strings.NewReader(string(body)), r)
	if err != nil {
		return room{}, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return room{}, fmt.Errorf("create room: HTTP %d", res.StatusCode)
	}
	var value struct {
		RoomID string `json:"roomId"`
	}
	err = json.NewDecoder(res.Body).Decode(&value)
	if err != nil {
		return room{}, fmt.Errorf("decode create response: %w", err)
	}
	if value.RoomID == "" {
		return room{}, fmt.Errorf("empty room ID")
	}
	return room{value.RoomID, anon}, nil
}
func join(ctx context.Context, client *http.Client, base, roomID, anon string, r *result) error {
	body, _ := json.Marshal(map[string]string{"anonId": anon})
	res, err := request(ctx, client, http.MethodPost, base+"/api/room/"+roomID+"/join", strings.NewReader(string(body)), r)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("join: HTTP %d", res.StatusCode)
	}
	return nil
}
func sendMessage(ctx context.Context, client *http.Client, base string, rm room, sequence uint64, r *result) bool {
	content := fmt.Sprintf("loadtest-%d-%d", time.Now().UnixNano(), sequence)
	body, _ := json.Marshal(map[string]string{"anonId": rm.anon, "content": content})
	res, err := request(ctx, client, http.MethodPost, base+"/api/room/"+rm.id+"/message", strings.NewReader(string(body)), r)
	if err == nil {
		defer res.Body.Close()
		if res.StatusCode == http.StatusOK {
			r.sent.Add(1)
			return true
		}
	}
	return false
}

func sse(ctx context.Context, client *http.Client, base string, rm room, ready chan<- bool, r *result) {
	res, err := request(ctx, client, http.MethodGet, base+"/api/room/"+rm.id+"/sse?anonId="+url.QueryEscape(rm.anon), nil, r)
	if err != nil || res.StatusCode != http.StatusOK {
		if res != nil {
			res.Body.Close()
		}
		ready <- false
		return
	}
	defer res.Body.Close()
	readySent := false
	scanner := bufio.NewScanner(res.Body)
	scanner.Buffer(make([]byte, 64<<10), 1<<20)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var event struct {
			Type    string `json:"type"`
			Payload struct {
				Content string `json:"content"`
			} `json:"payload"`
		}
		if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event) != nil {
			continue
		}
		if !readySent && event.Type == "snapshot" {
			ready <- true
			readySent = true
		}
		if strings.HasPrefix(event.Payload.Content, "loadtest-") {
			parts := strings.SplitN(strings.TrimPrefix(event.Payload.Content, "loadtest-"), "-", 2)
			if stamp, parseErr := strconv.ParseInt(parts[0], 10, 64); parseErr == nil {
				r.delivered.Add(1)
				r.mu.Lock()
				r.deliveryLat = append(r.deliveryLat, time.Since(time.Unix(0, stamp)))
				r.mu.Unlock()
			}
		}
	}
	if !readySent {
		ready <- false
	}
}

func fanout(ctx context.Context, client *http.Client, base string, clients, rate int, duration time.Duration, r *result) {
	rm, err := createRoom(ctx, client, base, r)
	if err != nil {
		fmt.Printf("setup_error=%v\n", err)
		return
	}
	streamCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	ready := make(chan bool, clients+1)
	var wg sync.WaitGroup
	start := func(anon string) {
		wg.Add(1)
		go func() { defer wg.Done(); sse(streamCtx, client, base, room{rm.id, anon}, ready, r) }()
	}
	start(rm.anon)
	accepted := 1
	for i := 0; i < clients; i++ {
		anon, idErr := identity(ctx, client, base, r)
		if idErr != nil || join(ctx, client, base, rm.id, anon, r) != nil {
			fmt.Printf("setup_error=client_%d\n", i)
			continue
		}
		start(anon)
		accepted++
	}
	for i := 0; i < accepted; i++ {
		if !(<-ready) {
			fmt.Printf("stream_setup_error=true\n")
			cancel()
			wg.Wait()
			return
		}
	}
	ticker := time.NewTicker(time.Second / time.Duration(rate))
	defer ticker.Stop()
	deadline := time.NewTimer(duration)
	defer deadline.Stop()
	var sequence uint64
	for {
		select {
		case <-deadline.C:
			cancel()
			wg.Wait()
			return
		case <-ctx.Done():
			cancel()
			wg.Wait()
			return
		case <-ticker.C:
			sequence++
			if sendMessage(ctx, client, base, rm, sequence, r) {
				r.expected.Add(uint64(accepted))
			}
		}
	}
}
func roomDensity(ctx context.Context, client *http.Client, base string, count int, r *result) {
	created := 0
	for i := 0; i < count; i++ {
		if _, err := createRoom(ctx, client, base, r); err != nil {
			fmt.Printf("room_create_stop=%d error=%v\n", created, err)
			break
		}
		created++
	}
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-deadline.C:
			fmt.Printf("rooms_created=%d\n", created)
			return
		case <-ctx.Done():
			return
		case <-ticker.C:
			res, err := request(ctx, client, http.MethodGet, base+"/api/room", nil, r)
			if err == nil {
				res.Body.Close()
			}
		}
	}
}
func churn(ctx context.Context, client *http.Client, base string, rate int, duration time.Duration, r *result) {
	rm, err := createRoom(ctx, client, base, r)
	if err != nil {
		fmt.Printf("setup_error=%v\n", err)
		return
	}
	ticker := time.NewTicker(time.Second / time.Duration(rate))
	defer ticker.Stop()
	deadline := time.NewTimer(duration)
	defer deadline.Stop()
	for {
		select {
		case <-deadline.C:
			return
		case <-ctx.Done():
			return
		case <-ticker.C:
			anon, idErr := identity(ctx, client, base, r)
			if idErr != nil || join(ctx, client, base, rm.id, anon, r) != nil {
				continue
			}
			connectionCtx, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
			ready := make(chan bool, 1)
			go sse(connectionCtx, client, base, room{rm.id, anon}, ready, r)
			<-ready
			cancel()
		}
	}
}
func sampleMetrics(ctx context.Context, client *http.Client, base string, r *result) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			res, err := request(ctx, client, http.MethodGet, base+"/metrics", nil, r)
			if err != nil {
				continue
			}
			body, _ := io.ReadAll(res.Body)
			res.Body.Close()
			if res.StatusCode != http.StatusOK {
				continue
			}
			values := map[string]uint64{}
			for _, line := range strings.Split(string(body), "\n") {
				fields := strings.Fields(line)
				if len(fields) == 2 {
					if value, parseErr := strconv.ParseUint(fields[1], 10, 64); parseErr == nil {
						values[fields[0]] = value
					}
				}
			}
			r.metrics.Store(&metricSample{values})
		}
	}
}
func percentile(values []time.Duration, percent int) time.Duration {
	if len(values) == 0 {
		return 0
	}
	sort.Slice(values, func(i, j int) bool { return values[i] < values[j] })
	return values[(len(values)-1)*percent/100]
}
func report(r *result) {
	r.mu.Lock()
	httpLat := append([]time.Duration(nil), r.httpLat...)
	deliveryLat := append([]time.Duration(nil), r.deliveryLat...)
	r.mu.Unlock()
	fmt.Printf("requests=%d network_errors=%d status_2xx=%d status_4xx=%d status_5xx=%d sent=%d expected_deliveries=%d delivered=%d\n", r.requests.Load(), r.networkErrors.Load(), r.status[2].Load(), r.status[4].Load(), r.status[5].Load(), r.sent.Load(), r.expected.Load(), r.delivered.Load())
	if expected := r.expected.Load(); expected > 0 {
		fmt.Printf("delivery_ratio=%.4f\n", float64(r.delivered.Load())/float64(expected))
	}
	for _, item := range []struct {
		name   string
		values []time.Duration
	}{{"http", httpLat}, {"delivery", deliveryLat}} {
		for _, p := range []int{50, 95, 99} {
			if value := percentile(item.values, p); value > 0 {
				fmt.Printf("p%d_%s=%s\n", p, item.name, value)
			}
		}
	}
	if sample := r.metrics.Load(); sample != nil {
		for _, key := range []string{"memory_usage_bytes", "goroutines", "rooms_active", "users_active", "subscribers_active", "room_command_queue_depth", "sse_slow_consumer_disconnects_total", "event_ring_overflow_total"} {
			fmt.Printf("%s=%d\n", key, sample.values[key])
		}
	}
}
