package chat

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	_ "net/http/pprof"
	"runtime"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

type App struct {
	config  Config
	rooms   *registry
	static  http.Handler
	limiter *rateLimiter
}

func (a *App) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	statusWriter := &responseWriter{ResponseWriter: w, status: http.StatusOK}
	if strings.HasPrefix(r.URL.Path, "/debug/pprof/") {
		if !a.pprofAuthorized(r) {
			http.NotFound(statusWriter, r)
		} else {
			http.DefaultServeMux.ServeHTTP(statusWriter, r)
		}
	} else if r.URL.Path == "/healthz" {
		statusWriter.WriteHeader(http.StatusOK)
		_, _ = statusWriter.Write([]byte("ok\n"))
	} else if r.URL.Path == "/readyz" {
		a.rooms.mu.RLock()
		draining := a.rooms.draining || len(a.rooms.active) >= a.config.Limits.MaxRooms
		a.rooms.mu.RUnlock()
		if draining {
			statusWriter.WriteHeader(http.StatusServiceUnavailable)
			_, _ = statusWriter.Write([]byte("draining\n"))
		} else {
			statusWriter.WriteHeader(http.StatusOK)
			_, _ = statusWriter.Write([]byte("ready\n"))
		}
	} else if r.URL.Path == "/metrics" {
		a.writeMetrics(statusWriter)
	} else if r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/") {
		a.serveAPI(statusWriter, r)
	} else {
		a.static.ServeHTTP(statusWriter, r)
	}
	duration := time.Since(started)
	if statusWriter.status >= 500 || duration >= time.Second {
		slog.Warn("slow or failed http request", "method", r.Method, "path", r.URL.Path, "status", statusWriter.status, "duration", duration)
	}
}

func isLoopbackPeer(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return false
	}
	address := net.ParseIP(host)
	return address != nil && address.IsLoopback()
}

func hasForwardedHeaders(r *http.Request) bool {
	return r.Header.Get("Forwarded") != "" || r.Header.Get("X-Forwarded-For") != "" || r.Header.Get("X-Real-IP") != ""
}

func (a *App) pprofAuthorized(r *http.Request) bool {
	if a.config.PprofToken == "" || !isLoopbackPeer(r.RemoteAddr) || hasForwardedHeaders(r) {
		return false
	}
	provided := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if len(provided) != len(a.config.PprofToken) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(provided), []byte(a.config.PprofToken)) == 1
}

func (a *App) clientIP(r *http.Request) string {
	peer := remotePeer(r.RemoteAddr)
	if peer.IsValid() && trusted(peer, a.config.TrustedProxyCIDRs) {
		if value := validClientAddress(r.Header.Get("CF-Connecting-IP")); value.IsValid() {
			return value.String()
		}
		return clientIP(r.RemoteAddr, strings.Join(r.Header.Values("X-Forwarded-For"), ","), a.config.TrustedProxyCIDRs)
	}
	if peer.IsValid() {
		return peer.String()
	}
	return strings.TrimSpace(r.RemoteAddr)
}

type responseWriter struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (w *responseWriter) WriteHeader(status int) {
	if w.wroteHeader {
		return
	}
	w.wroteHeader = true
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *responseWriter) Flush() {
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (w *responseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (a *App) writeMetrics(w http.ResponseWriter) {
	controller := http.NewResponseController(w)
	if err := controller.SetWriteDeadline(time.Now().Add(10 * time.Second)); err == nil {
		defer controller.SetWriteDeadline(time.Time{})
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	list := a.rooms.list()
	a.rooms.mu.RLock()
	queueDepth := 0
	for _, ref := range a.rooms.active {
		queueDepth += len(ref.commands)
	}
	a.rooms.mu.RUnlock()
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	metrics := a.rooms.metrics
	fmt.Fprintf(w, "rooms_active %d\nusers_active %d\nsubscribers_active %d\n", list.Stats.TotalRooms, list.Stats.ActiveUsers, metrics.sseActive.Load())
	fmt.Fprintf(w, "room_commands_total %d\nroom_command_latency_seconds_sum %f\nroom_command_queue_depth %d\nactor_busy_time_seconds_sum %f\n", metrics.roomCommands.Load(), float64(metrics.commandLatencyNS.Load())/1e9, queueDepth, float64(metrics.actorBusyNS.Load())/1e9)
	fmt.Fprintf(w, "events_total %d\nevent_ring_overflow_total %d\nmessages_total %d\npoll_votes_total %d\n", metrics.events.Load(), metrics.eventRingOverflow.Load(), metrics.messages.Load(), metrics.pollVotes.Load())
	fmt.Fprintf(w, "sse_connections %d\nsse_reconnects_total %d\nsse_slow_consumer_disconnects_total %d\nsse_replay_total %d\nsse_snapshot_total %d\n", metrics.sseActive.Load(), metrics.sseReconnects.Load(), metrics.sseSlowDisconnects.Load(), metrics.sseReplay.Load(), metrics.sseSnapshots.Load())
	fmt.Fprintf(w, "memory_usage_bytes %d\ngoroutines %d\n", memory.Alloc, runtime.NumGoroutine())
}

func (a *App) serveAPI(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) == 2 && parts[0] == "api" && parts[1] == "anon" {
		if !method(w, r, http.MethodGet) {
			return
		}
		id, err := newAnonID()
		if err != nil {
			writeAPIError(w, errUnavailable)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"anonId": id})
		return
	}
	if len(parts) == 2 && parts[0] == "api" && parts[1] == "room" {
		switch r.Method {
		case http.MethodGet:
			w.Header().Set("Cache-Control", "public, max-age=2")
			writeJSON(w, http.StatusOK, a.rooms.list())
		case http.MethodPost:
			a.createRoom(w, r)
		default:
			method(w, r, http.MethodGet, http.MethodPost)
		}
		return
	}
	if len(parts) >= 4 && parts[0] == "api" && parts[1] == "room" {
		roomID := parts[2]
		if len(parts) == 4 && parts[3] == "signal" && (r.Method == http.MethodGet || r.Method == http.MethodPost) {
			writeAPIError(w, apiError(http.StatusNotFound, "signal_disabled"))
			return
		}
		if len(parts) == 4 {
			switch parts[3] {
			case "join":
				if method(w, r, http.MethodPost) {
					a.joinRoom(w, r, roomID)
				}
			case "message":
				if method(w, r, http.MethodPost) {
					a.sendMessage(w, r, roomID)
				}
			case "meta":
				if method(w, r, http.MethodGet) {
					a.roomCommand(w, r, roomID, "meta", nil)
				}
			case "visibility":
				if method(w, r, http.MethodPatch) {
					a.setVisibility(w, r, roomID)
				}
			case "state":
				if method(w, r, http.MethodGet) {
					a.getState(w, r, roomID)
				}
			case "sse":
				if method(w, r, http.MethodGet) {
					a.stream(w, r, roomID)
				}
			case "poll":
				switch r.Method {
				case http.MethodGet:
					a.roomCommand(w, r, roomID, "poll-get", nil)
				case http.MethodPost:
					a.createPoll(w, r, roomID)
				default:
					method(w, r, http.MethodGet, http.MethodPost)
				}
			default:
				writeAPIError(w, apiError(http.StatusNotFound, "not_found"))
			}
			return
		}
		if len(parts) == 5 && parts[3] == "poll" {
			switch r.Method {
			case http.MethodPost:
				a.castVote(w, r, roomID, parts[4])
			case http.MethodPatch:
				a.closePoll(w, r, roomID, parts[4])
			case http.MethodDelete:
				a.deletePoll(w, r, roomID, parts[4])
			default:
				method(w, r, http.MethodPost, http.MethodPatch, http.MethodDelete)
			}
			return
		}
	}
	writeAPIError(w, apiError(http.StatusNotFound, "not_found"))
}

func (a *App) createRoom(w http.ResponseWriter, r *http.Request) {
	var input struct {
		AnonID string `json:"anonId"`
	}
	if err := a.decode(r, &input); err != nil {
		writeAPIError(w, errInvalidAnonID)
		return
	}
	if !validateAnonID(input.AnonID) {
		writeAPIError(w, errInvalidAnonID)
		return
	}
	if apiErr := a.rooms.checkCapacity(); apiErr != nil {
		writeAPIError(w, apiErr)
		return
	}
	if !a.allow("create:"+a.clientIP(r), 5) {
		writeAPIError(w, apiError(429, "rate_limited"))
		return
	}
	roomID, ownerID, capability, apiErr := a.rooms.create(input.AnonID)
	if apiErr != nil {
		writeAPIError(w, apiErr)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"roomId": roomID, "ownerId": ownerID, "ownerCapability": capability})
}

func (a *App) joinRoom(w http.ResponseWriter, r *http.Request, roomID string) {
	var input struct {
		AnonID string `json:"anonId"`
	}
	if err := a.decode(r, &input); err != nil {
		writeAPIError(w, errInvalidAnonID)
		return
	}
	if !validateAnonID(input.AnonID) {
		writeAPIError(w, errInvalidAnonID)
		return
	}
	ref, apiErr := a.rooms.acquire(roomID)
	if apiErr != nil {
		writeAPIError(w, apiErr)
		return
	}
	defer a.rooms.release(ref)
	if !a.allow("join:"+a.clientIP(r)+":"+roomID, 30) {
		writeAPIError(w, apiError(429, "rate_limited"))
		return
	}
	a.runRoomCommandWithRef(w, r, ref, "join", input.AnonID)
}

func (a *App) sendMessage(w http.ResponseWriter, r *http.Request, roomID string) {
	var input struct {
		AnonID  string `json:"anonId"`
		Content string `json:"content"`
	}
	if err := a.decode(r, &input); err != nil {
		writeAPIError(w, apiError(400, "invalid_message"))
		return
	}
	content := strings.TrimSpace(input.Content)
	if !validateAnonID(input.AnonID) || content == "" || !utf8.ValidString(input.Content) || len(content) > a.config.Limits.MaxMessageBytes {
		writeAPIError(w, apiError(400, "invalid_message"))
		return
	}
	ref, apiErr := a.rooms.acquire(roomID)
	if apiErr != nil {
		writeAPIError(w, apiErr)
		return
	}
	defer a.rooms.release(ref)
	ip := a.clientIP(r)
	if !a.allow("message-global:"+ip, 200) || !a.allow("message-ip:"+ip+":"+roomID, 100) {
		writeAPIError(w, apiError(429, "rate_limited"))
		return
	}
	if !a.allow("message-slot:"+ip+":"+strconv.Itoa(int(anonymousLimiterSlot(input.AnonID))), 30) {
		writeAPIError(w, apiError(429, "rate_limited"))
		return
	}
	a.runRoomCommandWithRef(w, r, ref, "message", messageInput{AnonID: input.AnonID, Content: content})
}

func (a *App) setVisibility(w http.ResponseWriter, r *http.Request, roomID string) {
	var input struct {
		AnonID     string `json:"anonId"`
		Capability string `json:"ownerCapability"`
		IsPublic   *bool  `json:"isPublic"`
	}
	if err := a.decode(r, &input); err != nil || input.IsPublic == nil {
		writeAPIError(w, errInvalidPayload)
		return
	}
	if !validateAnonID(input.AnonID) {
		writeAPIError(w, errInvalidPayload)
		return
	}
	a.runRoomCommand(w, r, roomID, "visibility", visibilityInput{input.AnonID, input.Capability, *input.IsPublic})
}

func (a *App) createPoll(w http.ResponseWriter, r *http.Request, roomID string) {
	var input struct {
		AnonID     string   `json:"anonId"`
		Capability string   `json:"ownerCapability"`
		Question   string   `json:"question"`
		Options    []string `json:"options"`
	}
	if err := a.decode(r, &input); err != nil {
		writeAPIError(w, apiError(400, "invalid_poll"))
		return
	}
	question := strings.TrimSpace(input.Question)
	valid := validateAnonID(input.AnonID) && question != "" && len(question) <= 256 && len(input.Options) >= 2 && len(input.Options) <= a.config.Limits.MaxPollOptions
	for index, option := range input.Options {
		input.Options[index] = strings.TrimSpace(option)
		if input.Options[index] == "" || len(input.Options[index]) > 128 {
			valid = false
		}
	}
	if !valid {
		writeAPIError(w, apiError(400, "invalid_poll"))
		return
	}
	a.runRoomCommand(w, r, roomID, "poll-create", pollInput{input.AnonID, input.Capability, question, input.Options})
}

func (a *App) castVote(w http.ResponseWriter, r *http.Request, roomID, pollID string) {
	var input struct {
		AnonID   string `json:"anonId"`
		OptionID string `json:"optionId"`
	}
	if err := a.decode(r, &input); err != nil || !validateAnonID(input.AnonID) || input.OptionID == "" {
		writeAPIError(w, apiError(400, "invalid_vote"))
		return
	}
	ref, apiErr := a.rooms.acquire(roomID)
	if apiErr != nil {
		writeAPIError(w, apiErr)
		return
	}
	defer a.rooms.release(ref)
	_, apiErr = a.callRoomUnmetered(r, ref, "validate-vote", voteInput{input.AnonID, pollID, input.OptionID})
	if apiErr != nil {
		writeAPIError(w, apiErr)
		return
	}
	ip := a.clientIP(r)
	if !a.allow("vote-global:"+ip, 200) || !a.allow("vote-ip:"+ip+":"+roomID, 100) {
		writeAPIError(w, apiError(429, "rate_limited"))
		return
	}
	if !a.allow("vote-slot:"+ip+":"+strconv.Itoa(int(anonymousLimiterSlot(input.AnonID))), 30) {
		writeAPIError(w, apiError(429, "rate_limited"))
		return
	}
	a.runRoomCommandWithRef(w, r, ref, "vote", voteInput{input.AnonID, pollID, input.OptionID})
}

func (a *App) closePoll(w http.ResponseWriter, r *http.Request, roomID, pollID string) {
	var input struct {
		AnonID     string `json:"anonId"`
		Capability string `json:"ownerCapability"`
		Active     *bool  `json:"active"`
	}
	if err := a.decode(r, &input); err != nil || input.Active == nil || *input.Active || !validateAnonID(input.AnonID) {
		writeAPIError(w, errInvalidPayload)
		return
	}
	a.runRoomCommand(w, r, roomID, "poll-close", pollMutation{input.AnonID, input.Capability, pollID})
}

func (a *App) deletePoll(w http.ResponseWriter, r *http.Request, roomID, pollID string) {
	var input struct {
		AnonID     string `json:"anonId"`
		Capability string `json:"ownerCapability"`
	}
	if err := a.decode(r, &input); err != nil || !validateAnonID(input.AnonID) {
		writeAPIError(w, errInvalidAnonID)
		return
	}
	a.runRoomCommand(w, r, roomID, "poll-delete", pollMutation{input.AnonID, input.Capability, pollID})
}

func (a *App) getState(w http.ResponseWriter, r *http.Request, roomID string) {
	anonID := r.URL.Query().Get("anonId")
	if !validateAnonID(anonID) {
		writeAPIError(w, errInvalidAnonID)
		return
	}
	a.runRoomCommand(w, r, roomID, "state", anonID)
}

func (a *App) roomCommand(w http.ResponseWriter, r *http.Request, roomID, kind string, data any) {
	a.runRoomCommand(w, r, roomID, kind, data)
}

func (a *App) runRoomCommand(w http.ResponseWriter, r *http.Request, roomID, kind string, data any) {
	ref, apiErr := a.rooms.acquire(roomID)
	if apiErr != nil {
		writeAPIError(w, apiErr)
		return
	}
	defer a.rooms.release(ref)
	a.runRoomCommandWithRef(w, r, ref, kind, data)
}

func (a *App) runRoomCommandWithRef(w http.ResponseWriter, r *http.Request, ref *roomRef, kind string, data any) {
	value, apiErr := a.callRoom(r, ref, kind, data)
	if apiErr != nil {
		writeAPIError(w, apiErr)
		return
	}
	writeJSON(w, http.StatusOK, value)
}

func (a *App) callRoom(r *http.Request, ref *roomRef, kind string, data any) (any, *APIError) {
	if !a.allowActorCommand(r, ref.id) {
		return nil, apiError(429, "rate_limited")
	}
	return a.callRoomUnmetered(r, ref, kind, data)
}

func (a *App) callRoomUnmetered(r *http.Request, ref *roomRef, kind string, data any) (any, *APIError) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	return call(ctx, ref, kind, data)
}

func (a *App) allowActorCommand(r *http.Request, roomID string) bool {
	ip := a.clientIP(r)
	return a.allow("actor-global:"+ip, 300) && a.allow("actor-room:"+ip+":"+roomID, 120)
}

func (a *App) stream(w http.ResponseWriter, r *http.Request, roomID string) {
	anonID := r.URL.Query().Get("anonId")
	if !validateAnonID(anonID) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, "Missing anonId")
		return
	}
	ref, apiErr := a.rooms.acquire(roomID)
	if apiErr != nil {
		if apiErr == errRoomNotFound || apiErr == errRoomClosed {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(apiErr.Status)
			if apiErr == errRoomClosed {
				_, _ = io.WriteString(w, "Room closed")
			} else {
				_, _ = io.WriteString(w, "Room not found")
			}
			return
		}
		writeAPIError(w, apiErr)
		return
	}
	defer a.rooms.release(ref)
	if !a.allow("sse:"+a.clientIP(r)+":"+roomID, 20) {
		if !a.allowActorCommand(r, roomID) {
			writeAPIError(w, apiError(429, "rate_limited"))
			return
		}
		writeAPIError(w, apiError(429, "rate_limited"))
		return
	}
	input := subscribeInput{AnonID: anonID, Context: r.Context()}
	input.Cursor, input.HasCursor = eventCursor(r)
	commandContext, cancelCommand := context.WithTimeout(r.Context(), 5*time.Second)
	value, apiErr := call(commandContext, ref, "subscribe", input)
	cancelCommand()
	if apiErr != nil {
		writeAPIError(w, apiErr)
		return
	}
	sub := value.(*subscriber)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher, ok := w.(http.Flusher)
	if !ok {
		return
	}
	if err := writeAndFlush(w, flusher, nil); err != nil {
		return
	}
	ticker := time.NewTicker(a.config.Limits.HeartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case frame, open := <-sub.frames:
			if !open {
				return
			}
			if err := writeAndFlush(w, flusher, frame); err != nil {
				return
			}
		case <-ticker.C:
			if err := writeAndFlush(w, flusher, []byte("event: ping\ndata: {\"type\":\"ping\"}\n\n")); err != nil {
				return
			}
		case <-r.Context().Done():
			return
		}
	}
}

func eventCursor(r *http.Request) (uint64, bool) {
	cursor := r.Header.Get("Last-Event-ID")
	if cursor == "" {
		cursor = r.URL.Query().Get("lastEventId")
	}
	parsed, err := strconv.ParseUint(cursor, 10, 64)
	if err != nil || parsed == 0 {
		return 0, false
	}
	return parsed, true
}

func writeAndFlush(w http.ResponseWriter, flusher http.Flusher, frame []byte) error {
	controller := http.NewResponseController(w)
	if err := controller.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil && !errors.Is(err, http.ErrNotSupported) {
		return err
	}
	defer controller.SetWriteDeadline(time.Time{})
	if len(frame) > 0 {
		if _, err := w.Write(frame); err != nil {
			return err
		}
	}
	flusher.Flush()
	return nil
}

func (a *App) decode(r *http.Request, target any) error {
	body, err := io.ReadAll(io.LimitReader(r.Body, a.config.Limits.MaxRequestBodyBytes+1))
	if err != nil || int64(len(body)) > a.config.Limits.MaxRequestBodyBytes || !utf8.Valid(body) {
		return fmt.Errorf("invalid body")
	}
	return json.Unmarshal(body, target)
}

func (a *App) allow(key string, capacity int) bool {
	multiplier := a.config.RateLimitMultiplier
	if multiplier < 1 {
		multiplier = 1
	}
	return a.limiter.allow(key, capacity*multiplier, time.Minute, time.Now())
}

func (a *App) BeginDrain() { a.rooms.markDraining() }

func (a *App) Shutdown(ctx context.Context) error {
	refs := a.rooms.markDraining()
	for _, ref := range refs {
		command := command{kind: "shutdown", reply: make(chan response, 1)}
		select {
		case <-ref.done:
		case ref.commands <- command:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	for _, ref := range refs {
		select {
		case <-ref.done:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

func method(w http.ResponseWriter, r *http.Request, allowed ...string) bool {
	for _, candidate := range allowed {
		if r.Method == candidate {
			return true
		}
	}
	w.Header().Set("Allow", strings.Join(allowed, ", "))
	writeAPIError(w, apiError(http.StatusMethodNotAllowed, "method_not_allowed"))
	return false
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	controller := http.NewResponseController(w)
	if err := controller.SetWriteDeadline(time.Now().Add(10 * time.Second)); err == nil {
		defer controller.SetWriteDeadline(time.Time{})
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeAPIError(w http.ResponseWriter, apiErr *APIError) {
	if apiErr == nil {
		apiErr = errUnavailable
	}
	if apiErr.Status == http.StatusTooManyRequests || apiErr.Status >= http.StatusInternalServerError {
		slog.Warn("request rejected", "status", apiErr.Status, "code", apiErr.Code)
	}
	writeJSON(w, apiErr.Status, map[string]string{"error": apiErr.Code})
}
