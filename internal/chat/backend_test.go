package chat

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func testApp() *App {
	limits := DefaultLimits()
	limits.MaxRooms = 4
	limits.MaxMessagesPerRoom = 3
	limits.MaxEventRing = 4
	limits.MaxSSEQueueFrames = 4
	limits.OwnerGrace = 60 * time.Millisecond
	limits.HeartbeatInterval = 20 * time.Millisecond
	return NewServer(Config{Address: ":0", Limits: limits})
}

func requestJSON(t *testing.T, client *http.Client, method, url string, input any) (*http.Response, map[string]any) {
	t.Helper()
	var body io.Reader
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequest(method, url, body)
	if err != nil {
		t.Fatal(err)
	}
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var result map[string]any
	if response.Header.Get("Content-Type") != "text/event-stream" && response.StatusCode != http.StatusNoContent {
		_ = json.NewDecoder(response.Body).Decode(&result)
	}
	return response, result
}

func TestValidateAnonIDAndSecureIDs(t *testing.T) {
	if !validateAnonID("anon-0123456789") || validateAnonID("anon-ABC3456789") || validateAnonID("anonymous") {
		t.Fatal("anonymous ID validation did not enforce the contract")
	}
	id, err := newAnonID()
	if err != nil || !validateAnonID(id) {
		t.Fatalf("generated anon ID invalid: %q, %v", id, err)
	}
	capability, err := newOwnerCapability()
	if err != nil || len(capability) != 32 {
		t.Fatalf("owner capability invalid: %d, %v", len(capability), err)
	}
}

func TestMessageRingWrapAndSnapshotCopy(t *testing.T) {
	ring := NewMessageRing(2)
	ring.Append(Message{ID: "a"})
	ring.Append(Message{ID: "b"})
	ring.Append(Message{ID: "c"})
	snapshot := ring.Snapshot()
	if len(snapshot) != 2 || snapshot[0].ID != "b" || snapshot[1].ID != "c" {
		t.Fatalf("unexpected ring snapshot: %#v", snapshot)
	}
	snapshot[0].ID = "mutated"
	if ring.Snapshot()[0].ID != "b" {
		t.Fatal("snapshot aliases ring storage")
	}
}

func TestEventRingReplayAndGap(t *testing.T) {
	ring := NewEventRing(2)
	for seq := uint64(1); seq <= 3; seq++ {
		ring.Append(Event{Seq: seq, Data: []byte{byte(seq)}})
	}
	replay, ok := ring.ReplayAfter(1, 3)
	if !ok || len(replay) != 2 || replay[0].Seq != 2 || replay[1].Seq != 3 {
		t.Fatalf("unexpected replay: %#v, %v", replay, ok)
	}
	replay[0].Data[0] = 99
	if ring.items[ring.start].Data[0] == 99 {
		t.Fatal("replay aliases event ring storage")
	}
	if _, ok := ring.ReplayAfter(0, 3); ok {
		t.Fatal("old cursor should require snapshot fallback")
	}
	if _, ok := ring.ReplayAfter(4, 3); ok {
		t.Fatal("future cursor should require snapshot fallback")
	}
}

func TestRegistryCapacityLeaseAndClose(t *testing.T) {
	limits := DefaultLimits()
	limits.MaxRooms = 1
	registry := newRegistry(limits)
	roomID, _, _, apiErr := registry.create("anon-0123456789")
	if apiErr != nil {
		t.Fatal(apiErr)
	}
	if _, _, _, apiErr := registry.create("anon-1234567890"); apiErr == nil || apiErr.Code != "capacity_exhausted" {
		t.Fatalf("expected capacity error, got %v", apiErr)
	}
	ref, apiErr := registry.acquire(roomID)
	if apiErr != nil {
		t.Fatal(apiErr)
	}
	_, _ = invoke(ref, "shutdown", nil)
	if _, apiErr := registry.acquire(roomID); apiErr == nil || apiErr.Code != "room_closed" {
		t.Fatalf("expected closing response, got %v", apiErr)
	}
	registry.release(ref)
	select {
	case <-ref.done:
	case <-time.After(time.Second):
		t.Fatal("actor did not exit")
	}
	if _, apiErr := registry.acquire(roomID); apiErr == nil || apiErr.Code != "room_not_found" {
		t.Fatalf("expected removed room, got %v", apiErr)
	}
}

func TestFullActorCommandQueueReturnsOverloaded(t *testing.T) {
	ref := &roomRef{commands: make(chan command, 1), disconnects: make(chan uint64, 1), done: make(chan struct{})}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	firstResult := make(chan *APIError, 1)
	go func() {
		_, apiErr := call(ctx, ref, "first", nil)
		firstResult <- apiErr
	}()
	deadline := time.NewTimer(time.Second)
	ticker := time.NewTicker(time.Millisecond)
	defer deadline.Stop()
	defer ticker.Stop()
	for len(ref.commands) == 0 {
		select {
		case <-ticker.C:
		case <-deadline.C:
			t.Fatal("first command was not queued")
		}
	}
	if _, apiErr := call(ctx, ref, "second", nil); apiErr == nil || apiErr.Code != "overloaded" {
		t.Fatalf("full command queue returned %v, want overloaded", apiErr)
	}
	queued := <-ref.commands
	queued.reply <- response{value: "done"}
	if apiErr := <-firstResult; apiErr != nil {
		t.Fatalf("queued command did not complete: %v", apiErr)
	}
}

func TestOwnerGraceReconnectAndExpiry(t *testing.T) {
	app := testApp()
	defer app.Shutdown(context.Background())
	roomID, _, _, apiErr := app.rooms.create("anon-0123456789")
	if apiErr != nil {
		t.Fatal(apiErr)
	}
	ref, _ := app.rooms.acquire(roomID)
	defer app.rooms.release(ref)
	value, apiErr := invoke(ref, "subscribe", subscribeInput{AnonID: "anon-0123456789"})
	if apiErr != nil {
		t.Fatal(apiErr)
	}
	sub := value.(*subscriber)
	_, _ = invoke(ref, "unsubscribe", sub.id)
	value, apiErr = invoke(ref, "subscribe", subscribeInput{AnonID: "anon-0123456789"})
	if apiErr != nil {
		t.Fatal(apiErr)
	}
	sub = value.(*subscriber)
	select {
	case <-ref.done:
		t.Fatal("owner reconnect did not cancel grace timer")
	case <-time.After(100 * time.Millisecond):
	}
	_, _ = invoke(ref, "unsubscribe", sub.id)
	select {
	case <-ref.done:
	case <-time.After(time.Second):
		t.Fatal("owner grace expiry did not delete room")
	}
}

func TestNeverConnectedOwnerRoomExpires(t *testing.T) {
	limits := DefaultLimits()
	limits.OwnerGrace = 25 * time.Millisecond
	registry := newRegistry(limits)
	roomID, _, _, apiErr := registry.create("anon-0123456789")
	if apiErr != nil {
		t.Fatal(apiErr)
	}
	ref, apiErr := registry.acquire(roomID)
	if apiErr != nil {
		t.Fatal(apiErr)
	}
	defer registry.release(ref)
	select {
	case <-ref.done:
	case <-time.After(time.Second):
		t.Fatal("owner that never connected left a room behind")
	}
}

func TestPendingJoinExpiresBeforeCapacityCheck(t *testing.T) {
	limits := DefaultLimits()
	limits.MaxUsersPerRoom = 2
	now := time.Now().UTC()
	actor := &roomActor{
		limits: limits, ownerID: "anon-0123456789",
		users: map[string]*User{"anon-0123456789": {ID: "anon-0123456789", ConnectedAt: now}},
	}
	if result := actor.join("anon-1234567890"); result.err != nil {
		t.Fatal(result.err)
	}
	actor.users["anon-1234567890"].PendingUntil = now.Add(-time.Second)
	if result := actor.join("anon-abcdefghij"); result.err != nil {
		t.Fatalf("expired pending user blocked capacity: %v", result.err)
	}
	if _, exists := actor.users["anon-1234567890"]; exists {
		t.Fatal("expired pending user remains in room state")
	}
}

func TestRateLimiterExpiryAndKeyCapacity(t *testing.T) {
	limiter := newRateLimiter(1)
	now := time.Now()
	if !limiter.allow("one", 1, time.Minute, now) || limiter.allow("one", 1, time.Minute, now) {
		t.Fatal("token bucket did not enforce its capacity")
	}
	if limiter.allow("two", 1, time.Minute, now) {
		t.Fatal("limiter admitted a new key after reaching key capacity")
	}
	if !limiter.allow("one", 1, time.Minute, now.Add(time.Minute)) {
		t.Fatal("token bucket did not refill")
	}
	if !limiter.allow("two", 1, time.Minute, now.Add(11*time.Minute)) {
		t.Fatal("expired key was not removed")
	}
}

func TestBoundedSubscriberQueueDisconnectsSlowConsumer(t *testing.T) {
	limits := DefaultLimits()
	limits.MaxSSEQueueFrames = 1
	limits.OwnerGrace = time.Hour
	registry := newRegistry(limits)
	roomID, _, _, apiErr := registry.create("anon-0123456789")
	if apiErr != nil {
		t.Fatal(apiErr)
	}
	ref, _ := registry.acquire(roomID)
	defer registry.release(ref)
	value, apiErr := invoke(ref, "subscribe", subscribeInput{AnonID: "anon-0123456789"})
	if apiErr != nil {
		t.Fatal(apiErr)
	}
	sub := value.(*subscriber)
	_, apiErr = invoke(ref, "message", messageInput{AnonID: "anon-0123456789", Content: "overflow"})
	if apiErr != nil {
		t.Fatal(apiErr)
	}
	select {
	case _, open := <-sub.frames:
		if !open {
			t.Fatal("initial snapshot should remain readable before channel closure")
		}
	case <-time.After(time.Second):
		t.Fatal("initial snapshot was not queued")
	}
	select {
	case _, open := <-sub.frames:
		if open {
			t.Fatal("slow subscriber queue accepted an event after overflow")
		}
	case <-time.After(time.Second):
		t.Fatal("subscriber queue was not closed after overflow")
	}
	_, _ = invoke(ref, "shutdown", nil)
}

func TestSlowConnectionRemovalDoesNotEmitFalsePresenceChange(t *testing.T) {
	owner := "anon-0123456789"
	var summary RoomSummary
	actor := &roomActor{
		ref: &roomRef{id: "room"}, ownerID: owner, limits: DefaultLimits(), metrics: &runtimeMetrics{},
		users:  map[string]*User{owner: {ID: owner, ConnectedAt: time.Now(), Subscriptions: 2}},
		events: NewEventRing(4),
		subscribers: map[uint64]*subscriber{
			1: {id: 1, anonID: owner, frames: make(chan []byte, 1)},
			2: {id: 2, anonID: owner, frames: make(chan []byte, 1)},
		},
		updateSummary: func(value RoomSummary) { summary = value },
	}
	actor.subscribers[1].frames <- []byte("already queued")
	actor.emit("message", map[string]string{"content": "live"})
	if actor.events.Len() != 1 || actor.events.items[actor.events.start].Type != "message" {
		t.Fatalf("a false users event consumed replay space: %+v", actor.events.items)
	}
	if summary.SubscriberCount != 1 || summary.UserCount != 1 || !summary.HasOwner {
		t.Fatalf("summary after one connection drops: %+v", summary)
	}
	if len(actor.subscribers[2].frames) != 1 {
		t.Fatal("healthy connection did not receive the message")
	}
	for _, sub := range actor.subscribers {
		close(sub.frames)
	}
}

func TestSubscriberAdmissionReservesOwnerAndCapsPerUser(t *testing.T) {
	limits := DefaultLimits()
	limits.MaxSubscribers = 4
	limits.MaxSubscriptionsPerUser = 2
	limits.OwnerGrace = time.Hour
	registry := newRegistry(limits)
	roomID, owner, _, apiErr := registry.create("anon-0123456789")
	if apiErr != nil {
		t.Fatal(apiErr)
	}
	ref, _ := registry.acquire(roomID)
	defer registry.release(ref)
	participant := "anon-1234567890"
	firstValue, apiErr := invoke(ref, "subscribe", subscribeInput{AnonID: participant})
	if apiErr != nil {
		t.Fatal(apiErr)
	}
	first := firstValue.(*subscriber)
	secondValue, apiErr := invoke(ref, "subscribe", subscribeInput{AnonID: participant})
	if apiErr != nil {
		t.Fatalf("second connection for user was rejected: %v", apiErr)
	}
	if _, apiErr := invoke(ref, "subscribe", subscribeInput{AnonID: participant}); apiErr == nil || apiErr.Code != "overloaded" {
		t.Fatalf("per-user subscription cap was not enforced: %v", apiErr)
	}
	otherValue, apiErr := invoke(ref, "subscribe", subscribeInput{AnonID: "anon-0987654321"})
	if apiErr != nil {
		t.Fatalf("second participant could not connect: %v", apiErr)
	}
	if _, apiErr := invoke(ref, "subscribe", subscribeInput{AnonID: "anon-1111111111"}); apiErr == nil || apiErr.Code != "overloaded" {
		t.Fatalf("non-owner consumed reserved slot: %v", apiErr)
	}
	ownerValue, apiErr := invoke(ref, "subscribe", subscribeInput{AnonID: owner})
	if apiErr != nil {
		t.Fatalf("owner could not use reserved slot: %v", apiErr)
	}
	_, _ = invoke(ref, "unsubscribe", first.id)
	_, _ = invoke(ref, "unsubscribe", secondValue.(*subscriber).id)
	_, _ = invoke(ref, "unsubscribe", otherValue.(*subscriber).id)
	_, _ = invoke(ref, "unsubscribe", ownerValue.(*subscriber).id)
	_, _ = invoke(ref, "shutdown", nil)
}

func TestHTTPContractEndpoints(t *testing.T) {
	app := testApp()
	server := httptest.NewServer(app)
	defer server.Close()
	defer app.Shutdown(context.Background())
	client := server.Client()
	for _, path := range []string{"/api/room", "/api/room/not-a-room/join"} {
		request := httptest.NewRequest(http.MethodPost, path, strings.NewReader("{"))
		response := httptest.NewRecorder()
		app.ServeHTTP(response, request)
		var errorBody map[string]string
		_ = json.Unmarshal(response.Body.Bytes(), &errorBody)
		if response.Code != 400 || errorBody["error"] != "invalid_anon_id" {
			t.Errorf("malformed %s returned %d %v", path, response.Code, errorBody)
		}
	}
	response, anon := requestJSON(t, client, http.MethodGet, server.URL+"/api/anon", nil)
	if response.StatusCode != 200 || !validateAnonID(anon["anonId"].(string)) {
		t.Fatalf("anon endpoint: %d %v", response.StatusCode, anon)
	}
	owner := anon["anonId"].(string)
	response, created := requestJSON(t, client, http.MethodPost, server.URL+"/api/room", map[string]any{"anonId": owner})
	if response.StatusCode != 200 {
		t.Fatalf("create room: %d %v", response.StatusCode, created)
	}
	roomID := created["roomId"].(string)
	capability := created["ownerCapability"].(string)
	if strings.Contains(fmt.Sprint(app.rooms.list()), capability) {
		t.Fatal("owner capability leaked through room listing")
	}
	for _, path := range []string{"/meta", "/state?anonId=" + owner, "/poll"} {
		response, _ = requestJSON(t, client, http.MethodGet, server.URL+"/api/room/"+roomID+path, nil)
		if response.StatusCode != 200 {
			t.Errorf("GET %s returned %d", path, response.StatusCode)
		}
	}
	response, listing := requestJSON(t, client, http.MethodGet, server.URL+"/api/room", nil)
	if response.StatusCode != 200 || listing["stats"] == nil {
		t.Fatalf("list endpoint: %d %v", response.StatusCode, listing)
	}
	participant := "anon-1234567890"
	response, _ = requestJSON(t, client, http.MethodPost, server.URL+"/api/room/"+roomID+"/join", map[string]string{"anonId": participant})
	if response.StatusCode != 200 {
		t.Fatalf("join endpoint: %d", response.StatusCode)
	}
	response, _ = requestJSON(t, client, http.MethodPost, server.URL+"/api/room/"+roomID+"/message", map[string]string{"anonId": participant, "content": " hello "})
	if response.StatusCode != 200 {
		t.Fatalf("message endpoint: %d", response.StatusCode)
	}
	response, _ = requestJSON(t, client, http.MethodPatch, server.URL+"/api/room/"+roomID+"/visibility", map[string]any{"anonId": owner, "ownerCapability": capability, "isPublic": true})
	if response.StatusCode != 200 {
		t.Fatalf("visibility endpoint: %d", response.StatusCode)
	}
	response, pollCreated := requestJSON(t, client, http.MethodPost, server.URL+"/api/room/"+roomID+"/poll", map[string]any{"anonId": owner, "ownerCapability": capability, "question": "Choose?", "options": []string{"A", "B"}})
	if response.StatusCode != 200 {
		t.Fatalf("poll create: %d %v", response.StatusCode, pollCreated)
	}
	response, poll := requestJSON(t, client, http.MethodGet, server.URL+"/api/room/"+roomID+"/poll", nil)
	if response.StatusCode != 200 {
		t.Fatalf("poll get: %d", response.StatusCode)
	}
	pollID := poll["poll"].(map[string]any)["id"].(string)
	optionID := poll["poll"].(map[string]any)["options"].([]any)[0].(map[string]any)["id"].(string)
	response, _ = requestJSON(t, client, http.MethodPost, server.URL+"/api/room/"+roomID+"/poll/"+pollID, map[string]string{"anonId": participant, "optionId": optionID})
	if response.StatusCode != 200 {
		t.Fatalf("vote: %d", response.StatusCode)
	}
	secondOptionID := poll["poll"].(map[string]any)["options"].([]any)[1].(map[string]any)["id"].(string)
	response, _ = requestJSON(t, client, http.MethodPost, server.URL+"/api/room/"+roomID+"/poll/"+pollID, map[string]string{"anonId": participant, "optionId": secondOptionID})
	if response.StatusCode != 200 {
		t.Fatalf("vote replacement: %d", response.StatusCode)
	}
	response, currentPoll := requestJSON(t, client, http.MethodGet, server.URL+"/api/room/"+roomID+"/poll", nil)
	if response.StatusCode != 200 {
		t.Fatalf("poll after vote replacement: %d", response.StatusCode)
	}
	currentOptions := currentPoll["poll"].(map[string]any)["options"].([]any)
	if currentOptions[0].(map[string]any)["votes"].(float64) != 0 || currentOptions[1].(map[string]any)["votes"].(float64) != 1 {
		t.Fatalf("vote replacement counters are inconsistent: %#v", currentOptions)
	}
	response, _ = requestJSON(t, client, http.MethodPatch, server.URL+"/api/room/"+roomID+"/poll/"+pollID, map[string]any{"anonId": owner, "ownerCapability": capability, "active": false})
	if response.StatusCode != 200 {
		t.Fatalf("close poll: %d", response.StatusCode)
	}
	response, closed := requestJSON(t, client, http.MethodPost, server.URL+"/api/room/"+roomID+"/poll/"+pollID, map[string]string{"anonId": participant, "optionId": optionID})
	if response.StatusCode != 409 || closed["error"] != "poll_closed" {
		t.Fatalf("closed poll vote: %d %v", response.StatusCode, closed)
	}
	response, _ = requestJSON(t, client, http.MethodDelete, server.URL+"/api/room/"+roomID+"/poll/"+pollID, map[string]string{"anonId": owner, "ownerCapability": capability})
	if response.StatusCode != 200 {
		t.Fatalf("delete poll: %d", response.StatusCode)
	}
	response, deletedVote := requestJSON(t, client, http.MethodPost, server.URL+"/api/room/"+roomID+"/poll/"+pollID, map[string]string{"anonId": participant, "optionId": optionID})
	if response.StatusCode != 404 || deletedVote["error"] != "poll_not_found" {
		t.Fatalf("deleted poll vote: %d %v", response.StatusCode, deletedVote)
	}
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		response, result := requestJSON(t, client, method, server.URL+"/api/room/"+roomID+"/signal", nil)
		if response.StatusCode != 404 || result["error"] != "signal_disabled" {
			t.Errorf("signal %s: %d %v", method, response.StatusCode, result)
		}
	}
	response, missing := requestJSON(t, client, http.MethodGet, server.URL+"/api/room/no-such-room/meta", nil)
	if response.StatusCode != 404 || missing["error"] != "room_not_found" {
		t.Fatalf("missing room: %d %v", response.StatusCode, missing)
	}
}

func TestSSESnapshotReplayHeadersAndTerminalEvent(t *testing.T) {
	app := testApp()
	server := httptest.NewServer(app)
	defer server.Close()
	client := server.Client()
	_, anon := requestJSON(t, client, http.MethodGet, server.URL+"/api/anon", nil)
	owner := anon["anonId"].(string)
	_, created := requestJSON(t, client, http.MethodPost, server.URL+"/api/room", map[string]string{"anonId": owner})
	roomID := created["roomId"].(string)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	request, _ := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/api/room/"+roomID+"/sse?anonId="+owner, nil)
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.Header.Get("Content-Type") != "text/event-stream" || response.Header.Get("X-Accel-Buffering") != "no" {
		t.Fatalf("missing SSE headers: %v", response.Header)
	}
	reader := bufio.NewReader(response.Body)
	firstLine, err := reader.ReadString('\n')
	if err != nil || !strings.HasPrefix(firstLine, "id: 1") {
		t.Fatalf("expected initial snapshot id 1, got %q, %v", firstLine, err)
	}
	for {
		line, readErr := reader.ReadString('\n')
		if readErr != nil {
			t.Fatal(readErr)
		}
		if line == "\n" {
			break
		}
	}
	_, _ = requestJSON(t, client, http.MethodPost, server.URL+"/api/room/"+roomID+"/message", map[string]string{"anonId": owner, "content": "live"})
	messageFrame := make([]string, 0, 4)
	for len(messageFrame) < 4 {
		line, readErr := reader.ReadString('\n')
		if readErr != nil {
			t.Fatal(readErr)
		}
		messageFrame = append(messageFrame, line)
		if line == "\n" {
			break
		}
	}
	if !strings.Contains(strings.Join(messageFrame, ""), "event: message") {
		t.Fatalf("message was not streamed: %v", messageFrame)
	}
	heartbeat := make([]string, 0, 3)
	for len(heartbeat) < 3 {
		line, readErr := reader.ReadString('\n')
		if readErr != nil {
			t.Fatal(readErr)
		}
		heartbeat = append(heartbeat, line)
		if line == "\n" {
			break
		}
	}
	if !strings.Contains(strings.Join(heartbeat, ""), "event: ping") {
		t.Fatalf("SSE heartbeat missing: %v", heartbeat)
	}
	app.BeginDrain()
	if err := app.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	terminal := make([]string, 0, 4)
	for len(terminal) < 4 {
		line, readErr := reader.ReadString('\n')
		if readErr != nil {
			t.Fatal(readErr)
		}
		terminal = append(terminal, line)
		if line == "\n" {
			break
		}
	}
	if !strings.Contains(strings.Join(terminal, ""), "event: room-deleted") {
		t.Fatalf("terminal room-deleted event missing: %v", terminal)
	}
	response.Body.Close()
	cancel()
}

func TestGeneratedAnonIDPassesRoomValidation(t *testing.T) {
	app := testApp()
	defer app.Shutdown(context.Background())
	server := httptest.NewServer(app)
	defer server.Close()
	response, identity := requestJSON(t, server.Client(), http.MethodGet, server.URL+"/api/anon", nil)
	if response.StatusCode != http.StatusOK || !validateAnonID(identity["anonId"].(string)) {
		t.Fatalf("invalid generated identity: %d %v", response.StatusCode, identity)
	}
	response, _ = requestJSON(t, server.Client(), http.MethodPost, server.URL+"/api/room", map[string]string{"anonId": identity["anonId"].(string)})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("generated identity rejected by room create: %d", response.StatusCode)
	}
}

func TestStaticAssetsFallbackAndAPIIsolation(t *testing.T) {
	app := testApp()
	defer app.Shutdown(context.Background())
	server := httptest.NewServer(app)
	defer server.Close()
	client := server.Client()
	response, err := client.Get(server.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 200 || !strings.Contains(response.Header.Get("Content-Type"), "text/html") {
		t.Fatalf("index: %d %q", response.StatusCode, response.Header.Get("Content-Type"))
	}
	response.Body.Close()
	for _, roomPath := range []string{"/room", "/room/"} {
		response, err = client.Get(server.URL + roomPath)
		if err != nil {
			t.Fatal(err)
		}
		roomRoot, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != 200 || !bytes.Contains(roomRoot, []byte("__next")) {
			t.Fatalf("room root fallback for %s: %d", roomPath, response.StatusCode)
		}
	}
	response, err = client.Get(server.URL + "/manifest.webmanifest")
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 200 || !strings.HasPrefix(response.Header.Get("Content-Type"), "application/manifest+json") {
		t.Fatalf("web manifest response: %d %q", response.StatusCode, response.Header.Get("Content-Type"))
	}
	response.Body.Close()
	response, err = client.Get(server.URL + "/room/placeholder.txt")
	if err != nil {
		t.Fatal(err)
	}
	roomAsset, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 200 || strings.Contains(string(roomAsset), "<!DOCTYPE html>") {
		t.Fatalf("exact room asset was shadowed by fallback: %d", response.StatusCode)
	}
	static := app.static.(staticHandler)
	if static.exists("cache") || static.exists("server") || static.exists("package.json") {
		t.Fatal("Next development artifacts were embedded in the runtime asset filesystem")
	}
	hashedAsset := ""
	err = fs.WalkDir(static.files, "_next/static/chunks", func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if !entry.IsDir() && strings.HasSuffix(name, ".js") && strings.HasPrefix(name, "_next/static/chunks/") {
			hashedAsset = name
			return fs.SkipAll
		}
		return nil
	})
	if err != nil || hashedAsset == "" {
		t.Fatalf("no embedded hashed JavaScript asset found: %v", err)
	}
	response, err = client.Get(server.URL + "/" + hashedAsset)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 200 || !strings.Contains(response.Header.Get("Cache-Control"), "immutable") {
		t.Fatalf("hashed asset response: %d, %q", response.StatusCode, response.Header.Get("Cache-Control"))
	}
	response.Body.Close()
	request, _ := http.NewRequest(http.MethodHead, server.URL+"/"+hashedAsset, nil)
	response, err = client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 200 || response.ContentLength == 0 {
		t.Fatalf("HEAD hashed asset response: %d, length %d", response.StatusCode, response.ContentLength)
	}
	response.Body.Close()
	response, err = client.Get(server.URL + "/room/fresh-link")
	if err != nil {
		t.Fatal(err)
	}
	roomBody, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 200 || !bytes.Contains(roomBody, []byte("__next")) {
		t.Fatalf("room shell fallback: %d", response.StatusCode)
	}
	response, err = client.Get(server.URL + "/_next/static/chunks/missing.0123456789.js")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 404 {
		t.Fatalf("missing hashed asset: %d", response.StatusCode)
	}
	response, err = client.Get(server.URL + "/api/unknown-route")
	if err != nil {
		t.Fatal(err)
	}
	apiBody, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 404 || !bytes.Contains(apiBody, []byte(`"error"`)) || bytes.Contains(apiBody, []byte("<!DOCTYPE html>")) {
		t.Fatalf("API fallback occurred: %d %s", response.StatusCode, apiBody)
	}
	request, _ = http.NewRequest(http.MethodHead, server.URL+"/", nil)
	response, err = client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatalf("HEAD index: %d", response.StatusCode)
	}
}

func TestHealthReadinessAndMetrics(t *testing.T) {
	app := testApp()
	defer app.Shutdown(context.Background())
	server := httptest.NewServer(app)
	defer server.Close()
	for path, expected := range map[string]int{"/healthz": http.StatusOK, "/readyz": http.StatusOK, "/metrics": http.StatusOK} {
		response, err := server.Client().Get(server.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != expected {
			t.Errorf("%s returned %d", path, response.StatusCode)
		}
		if path == "/metrics" && (!bytes.Contains(body, []byte("room_commands_total")) || !bytes.Contains(body, []byte("sse_connections"))) {
			t.Errorf("metrics response omitted expected counters: %s", body)
		}
	}
	app.BeginDrain()
	response, err := server.Client().Get(server.URL + "/readyz")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("readiness remained healthy during drain: %d", response.StatusCode)
	}
}

func TestPprofIsLoopbackOnly(t *testing.T) {
	app := testApp()
	defer app.Shutdown(context.Background())
	app.config.PprofToken = "local-test-token"
	remote := httptest.NewRequest(http.MethodGet, "/debug/pprof/", nil)
	remote.RemoteAddr = "192.0.2.4:1234"
	remoteResponse := httptest.NewRecorder()
	app.ServeHTTP(remoteResponse, remote)
	if remoteResponse.Code != http.StatusNotFound {
		t.Fatalf("remote pprof request returned %d", remoteResponse.Code)
	}
	local := httptest.NewRequest(http.MethodGet, "/debug/pprof/", nil)
	local.RemoteAddr = "127.0.0.1:1234"
	local.Header.Set("Authorization", "Bearer local-test-token")
	localResponse := httptest.NewRecorder()
	app.ServeHTTP(localResponse, local)
	if localResponse.Code != http.StatusOK {
		t.Fatalf("loopback pprof request returned %d", localResponse.Code)
	}
	proxied := httptest.NewRequest(http.MethodGet, "/debug/pprof/", nil)
	proxied.RemoteAddr = "127.0.0.1:1234"
	proxied.Header.Set("X-Forwarded-For", "198.51.100.8")
	proxied.Header.Set("Authorization", "Bearer local-test-token")
	proxiedResponse := httptest.NewRecorder()
	app.ServeHTTP(proxiedResponse, proxied)
	if proxiedResponse.Code != http.StatusNotFound {
		t.Fatalf("proxied pprof request returned %d", proxiedResponse.Code)
	}
}

func TestRateLimitKeysRequireValidRoomAndPoll(t *testing.T) {
	app := testApp()
	server := httptest.NewServer(app)
	defer server.Close()
	defer app.Shutdown(context.Background())
	client := server.Client()
	_, created := requestJSON(t, client, http.MethodPost, server.URL+"/api/room", map[string]string{"anonId": "anon-0123456789"})
	roomID := created["roomId"].(string)
	before := limiterKeyCount(app.limiter)
	response, _ := requestJSON(t, client, http.MethodPost, server.URL+"/api/room/unknown/join", map[string]string{"anonId": "anon-1234567890"})
	if response.StatusCode != 404 || limiterKeyCount(app.limiter) != before {
		t.Fatalf("unknown room consumed a rate key: status=%d keys=%d/%d", response.StatusCode, limiterKeyCount(app.limiter), before)
	}
	response, _ = requestJSON(t, client, http.MethodPost, server.URL+"/api/room/"+roomID+"/poll/not-a-poll", map[string]string{"anonId": "anon-1234567890", "optionId": "not-an-option"})
	if response.StatusCode != 404 || limiterKeyCount(app.limiter) != before {
		t.Fatalf("invalid poll consumed a rate key: status=%d keys=%d/%d", response.StatusCode, limiterKeyCount(app.limiter), before)
	}
	response, _ = requestJSON(t, client, http.MethodPost, server.URL+"/api/room/unknown/message", map[string]string{"anonId": "anon-1234567890", "content": "valid"})
	if response.StatusCode != 404 || limiterKeyCount(app.limiter) != before {
		t.Fatalf("unknown message room consumed a rate key: status=%d keys=%d/%d", response.StatusCode, limiterKeyCount(app.limiter), before)
	}
}

func TestMessageRateLimitBoundsCallerControlledAnonKeys(t *testing.T) {
	app := testApp()
	app.config.Limits.MaxRooms = 16
	app.rooms.limits.MaxRooms = 16
	server := httptest.NewServer(app)
	defer server.Close()
	defer app.Shutdown(context.Background())
	client := server.Client()
	_, created := requestJSON(t, client, http.MethodPost, server.URL+"/api/room", map[string]string{"anonId": "anon-0123456789"})
	roomIDs := []string{created["roomId"].(string)}
	for range 9 {
		roomID, _, _, apiErr := app.rooms.create("anon-0123456789")
		if apiErr != nil {
			t.Fatal(apiErr)
		}
		roomIDs = append(roomIDs, roomID)
	}
	for index := 0; index < 200; index++ {
		roomID := roomIDs[index%len(roomIDs)]
		anonID := fmt.Sprintf("anon-%010d", index)
		response, _ := requestJSON(t, client, http.MethodPost, server.URL+"/api/room/"+roomID+"/message", map[string]string{"anonId": anonID, "content": "bounded"})
		if response.StatusCode != 200 {
			t.Fatalf("message %d returned %d before global per-IP bound", index, response.StatusCode)
		}
	}
	roomID := roomIDs[len(roomIDs)-1]
	response, result := requestJSON(t, client, http.MethodPost, server.URL+"/api/room/"+roomID+"/message", map[string]string{"anonId": "anon-9999999999", "content": "bounded"})
	if response.StatusCode != 429 || result["error"] != "rate_limited" {
		t.Fatalf("global per-IP bound returned %d %v", response.StatusCode, result)
	}
	if count := limiterKeyCount(app.limiter); count > 222 {
		t.Fatalf("caller-controlled IDs created %d limiter keys", count)
	}
}

func limiterKeyCount(limiter *rateLimiter) int {
	return int(limiter.count.Load())
}

func TestTrustedProxyClientIP(t *testing.T) {
	prefixes, err := parseTrustedProxyCIDRs("10.0.0.0/8, 2001:db8::/32")
	if err != nil {
		t.Fatal(err)
	}
	if got := clientIP("198.51.100.4:1234", "203.0.113.8", prefixes); got != "198.51.100.4" {
		t.Fatalf("untrusted peer changed client IP to %s", got)
	}
	if got := clientIP("10.0.0.4:1234", "198.51.100.8, 10.0.0.2", prefixes); got != "198.51.100.8" {
		t.Fatalf("trusted proxy chain resolved to %s", got)
	}
	if got := clientIP("10.0.0.4:1234", "malformed", prefixes); got != "10.0.0.4" {
		t.Fatalf("malformed forwarded chain was trusted: %s", got)
	}
	app := testApp()
	app.config.TrustedProxyCIDRs = prefixes
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.RemoteAddr = "10.0.0.4:1234"
	request.Header.Add("X-Forwarded-For", "198.51.100.8")
	request.Header.Add("X-Forwarded-For", "10.0.0.2")
	if got := app.clientIP(request); got != "198.51.100.8" {
		t.Fatalf("multi-line forwarded chain resolved to %s", got)
	}
	firstIPv6 := clientIP("[2001:db8:1234:5678::1]:1234", "", nil)
	secondIPv6 := clientIP("[2001:db8:1234:5678::2]:1234", "", nil)
	if firstIPv6 != secondIPv6 {
		t.Fatalf("IPv6 addresses in one /64 have different limiter keys: %s and %s", firstIPv6, secondIPv6)
	}
}

func TestActorCommandRateLimitCoversAllRoomOperations(t *testing.T) {
	app := testApp()
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.RemoteAddr = "192.0.2.10:1234"
	for index := 0; index < 120; index++ {
		if !app.allowActorCommand(request, "room-a") {
			t.Fatalf("actor command %d was rejected before room budget", index)
		}
	}
	if app.allowActorCommand(request, "room-a") {
		t.Fatal("actor read/mutation budget did not cap requests per room")
	}
	if !app.allowActorCommand(request, "room-b") {
		t.Fatal("per-room budget incorrectly exhausted the global actor budget")
	}
}

func TestSSERequestCancellationDetachesSubscriber(t *testing.T) {
	app := testApp()
	defer app.Shutdown(context.Background())
	roomID, owner, _, apiErr := app.rooms.create("anon-0123456789")
	if apiErr != nil {
		t.Fatal(apiErr)
	}
	ref, apiErr := app.rooms.acquire(roomID)
	if apiErr != nil {
		t.Fatal(apiErr)
	}
	defer app.rooms.release(ref)
	ctx, cancel := context.WithCancel(context.Background())
	value, apiErr := invoke(ref, "subscribe", subscribeInput{AnonID: owner, Context: ctx})
	if apiErr != nil {
		t.Fatal(apiErr)
	}
	sub := value.(*subscriber)
	cancel()
	deadline := time.NewTimer(time.Second)
	ticker := time.NewTicker(time.Millisecond)
	defer deadline.Stop()
	defer ticker.Stop()
	for {
		select {
		case <-deadline.C:
			t.Fatal("request cancellation did not detach subscriber")
		case <-ticker.C:
			app.rooms.mu.RLock()
			summary := app.rooms.summaries[roomID]
			app.rooms.mu.RUnlock()
			if summary.SubscriberCount == 0 && !summary.HasOwner {
				for len(sub.frames) > 0 {
					<-sub.frames
				}
				select {
				case _, open := <-sub.frames:
					if open {
						t.Fatal("subscriber frame queue remained open after cancellation")
					}
				case <-deadline.C:
					t.Fatal("subscriber frame queue remained open after cancellation")
				}
				_, _ = invoke(ref, "shutdown", nil)
				return
			}
		}
	}
}

func TestRegistrySubscriberCountTracksMultipleConnections(t *testing.T) {
	app := testApp()
	defer app.Shutdown(context.Background())
	roomID, owner, _, apiErr := app.rooms.create("anon-0123456789")
	if apiErr != nil {
		t.Fatal(apiErr)
	}
	ref, apiErr := app.rooms.acquire(roomID)
	if apiErr != nil {
		t.Fatal(apiErr)
	}
	defer app.rooms.release(ref)
	firstValue, apiErr := invoke(ref, "subscribe", subscribeInput{AnonID: owner})
	if apiErr != nil {
		t.Fatal(apiErr)
	}
	secondValue, apiErr := invoke(ref, "subscribe", subscribeInput{AnonID: owner})
	if apiErr != nil {
		t.Fatal(apiErr)
	}
	first := firstValue.(*subscriber)
	second := secondValue.(*subscriber)
	if got := app.rooms.summaries[roomID].SubscriberCount; got != 2 {
		t.Fatalf("subscriber count after second connection is %d, want 2", got)
	}
	_, _ = invoke(ref, "unsubscribe", first.id)
	if summary := app.rooms.summaries[roomID]; summary.SubscriberCount != 1 || !summary.HasOwner {
		t.Fatalf("summary after one disconnect is %+v", summary)
	}
	_, _ = invoke(ref, "unsubscribe", second.id)
	_, _ = invoke(ref, "shutdown", nil)
}

func TestHTTPMethodContract(t *testing.T) {
	app := testApp()
	defer app.Shutdown(context.Background())
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPut, "/api/anon", nil)
	app.ServeHTTP(response, request)
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("wrong method status: %d", response.Code)
	}
}

func TestReplayCursorFallsBackToSnapshot(t *testing.T) {
	ring := NewEventRing(2)
	ring.Append(Event{Seq: 2, Data: []byte("two")})
	ring.Append(Event{Seq: 3, Data: []byte("three")})
	if _, ok := ring.ReplayAfter(1, 3); !ok {
		t.Fatal("cursor immediately before oldest should replay")
	}
	if _, ok := ring.ReplayAfter(0, 3); ok {
		t.Fatal("cursor before retained boundary should snapshot")
	}
}

func TestActorReplayQueuesOrderedEventsBeforeSubscription(t *testing.T) {
	limits := DefaultLimits()
	limits.OwnerGrace = time.Hour
	registry := newRegistry(limits)
	roomID, owner, _, apiErr := registry.create("anon-0123456789")
	if apiErr != nil {
		t.Fatal(apiErr)
	}
	ref, _ := registry.acquire(roomID)
	defer registry.release(ref)
	initialValue, apiErr := invoke(ref, "subscribe", subscribeInput{AnonID: owner})
	if apiErr != nil {
		t.Fatal(apiErr)
	}
	initial := initialValue.(*subscriber)
	if frame := string(<-initial.frames); !strings.HasPrefix(frame, "id: 1\nevent: snapshot") {
		t.Fatalf("expected initial snapshot, got %q", frame)
	}
	_, _ = invoke(ref, "unsubscribe", initial.id)
	_, apiErr = invoke(ref, "message", messageInput{AnonID: owner, Content: "while disconnected"})
	if apiErr != nil {
		t.Fatal(apiErr)
	}
	replayValue, apiErr := invoke(ref, "subscribe", subscribeInput{AnonID: owner, Cursor: 1, HasCursor: true})
	if apiErr != nil {
		t.Fatal(apiErr)
	}
	replay := replayValue.(*subscriber)
	defer func() { _, _ = invoke(ref, "unsubscribe", replay.id); _, _ = invoke(ref, "shutdown", nil) }()
	var frames []string
	for index := 0; index < 3; index++ {
		frames = append(frames, string(<-replay.frames))
	}
	if !strings.HasPrefix(frames[0], "id: 2\nevent: users") || !strings.HasPrefix(frames[1], "id: 3\nevent: message") || !strings.HasPrefix(frames[2], "id: 4\nevent: users") {
		t.Fatalf("replay/presence order was not atomic: %q", frames)
	}
}

func TestRegistryListExposesOnlyPublicSummaries(t *testing.T) {
	app := testApp()
	defer app.Shutdown(context.Background())
	id, owner, _, err := app.rooms.create("anon-0123456789")
	if err != nil {
		t.Fatal(err)
	}
	ref, _ := app.rooms.acquire(id)
	defer app.rooms.release(ref)
	_, apiErr := invoke(ref, "visibility", visibilityInput{AnonID: owner, Capability: "invalid", IsPublic: true})
	if apiErr == nil || apiErr.Code != "forbidden" {
		t.Fatalf("invalid capability accepted: %v", apiErr)
	}
	list := app.rooms.list()
	if len(list.Rooms) != 0 || list.Stats.TotalRooms != 1 {
		t.Fatalf("private room listed: %+v", list)
	}
}

func TestRoomSnapshotDoesNotExposeCapability(t *testing.T) {
	app := testApp()
	defer app.Shutdown(context.Background())
	id, owner, capability, err := app.rooms.create("anon-0123456789")
	if err != nil {
		t.Fatal(err)
	}
	ref, _ := app.rooms.acquire(id)
	defer app.rooms.release(ref)
	value, apiErr := invoke(ref, "state", owner)
	if apiErr != nil {
		t.Fatal(apiErr)
	}
	data, _ := json.Marshal(value)
	if strings.Contains(string(data), capability) {
		t.Fatalf("capability leaked in snapshot: %s", data)
	}
}

func TestBodyBoundsAndStrictAnonID(t *testing.T) {
	app := testApp()
	defer app.Shutdown(context.Background())
	server := httptest.NewServer(app)
	defer server.Close()
	response, result := requestJSON(t, server.Client(), http.MethodPost, server.URL+"/api/room", map[string]string{"anonId": "anon-INVALID!"})
	if response.StatusCode != 400 || result["error"] != "invalid_anon_id" {
		t.Fatalf("invalid anon ID: %d %v", response.StatusCode, result)
	}
	body := strings.Repeat("x", int(app.config.Limits.MaxRequestBodyBytes)+1)
	response, result = requestJSON(t, server.Client(), http.MethodPost, server.URL+"/api/room", map[string]string{"anonId": body})
	if response.StatusCode != 400 || result["error"] != "invalid_anon_id" {
		t.Fatalf("oversized body: %d %v", response.StatusCode, result)
	}
}

func TestMessageByteLimit(t *testing.T) {
	app := testApp()
	defer app.Shutdown(context.Background())
	server := httptest.NewServer(app)
	defer server.Close()
	roomID, owner, _, apiErr := app.rooms.create("anon-0123456789")
	if apiErr != nil {
		t.Fatal(apiErr)
	}
	content := strings.Repeat("x", app.config.Limits.MaxMessageBytes)
	response, result := requestJSON(t, server.Client(), http.MethodPost, server.URL+"/api/room/"+roomID+"/message", map[string]string{"anonId": owner, "content": content})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("message at byte limit: %d %v", response.StatusCode, result)
	}
	response, result = requestJSON(t, server.Client(), http.MethodPost, server.URL+"/api/room/"+roomID+"/message", map[string]string{"anonId": owner, "content": content + "x"})
	if response.StatusCode != http.StatusBadRequest || result["error"] != "invalid_message" {
		t.Fatalf("message over byte limit: %d %v", response.StatusCode, result)
	}
}

func TestOwnerCapabilityConstantTimeAuthorization(t *testing.T) {
	app := testApp()
	defer app.Shutdown(context.Background())
	id, owner, capability, err := app.rooms.create("anon-0123456789")
	if err != nil {
		t.Fatal(err)
	}
	ref, _ := app.rooms.acquire(id)
	defer app.rooms.release(ref)
	if _, apiErr := invoke(ref, "visibility", visibilityInput{AnonID: owner, Capability: capability, IsPublic: true}); apiErr != nil {
		t.Fatalf("valid capability rejected: %v", apiErr)
	}
	if _, apiErr := invoke(ref, "visibility", visibilityInput{AnonID: owner, Capability: capability + "x", IsPublic: false}); apiErr == nil || apiErr.Code != "forbidden" {
		t.Fatalf("bad capability accepted: %v", apiErr)
	}
}

func TestActorSerializesConcurrentMessages(t *testing.T) {
	limits := DefaultLimits()
	limits.MaxMessagesPerRoom = 100
	registry := newRegistry(limits)
	id, owner, _, apiErr := registry.create("anon-0123456789")
	if apiErr != nil {
		t.Fatal(apiErr)
	}
	ref, _ := registry.acquire(id)
	defer registry.release(ref)
	const count = 40
	results := make(chan *APIError, count)
	for index := 0; index < count; index++ {
		go func(index int) {
			_, resultErr := invoke(ref, "message", messageInput{AnonID: owner, Content: fmt.Sprintf("message-%d", index)})
			results <- resultErr
		}(index)
	}
	for index := 0; index < count; index++ {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	value, apiErr := invoke(ref, "state", owner)
	if apiErr != nil {
		t.Fatal(apiErr)
	}
	if got := len(value.(map[string]any)["messages"].([]Message)); got != count {
		t.Fatalf("serialized message count %d, want %d", got, count)
	}
	_, _ = invoke(ref, "shutdown", nil)
}

func TestEventSequenceIsMonotonic(t *testing.T) {
	actor := &roomActor{events: NewEventRing(4), subscribers: map[uint64]*subscriber{}, limits: DefaultLimits(), metrics: &runtimeMetrics{}, ref: &roomRef{id: "room"}}
	actor.users = map[string]*User{}
	actor.emit("first", map[string]int{"n": 1})
	actor.emit("second", map[string]int{"n": 2})
	if actor.seq != 2 || actor.events.items[0].Seq != 1 || actor.events.items[1].Seq != 2 {
		t.Fatalf("nonmonotonic sequence: %d %+v", actor.seq, actor.events)
	}
}

func TestSSECursorParsing(t *testing.T) {
	query := httptest.NewRequest(http.MethodGet, "/sse?lastEventId=27", nil)
	if cursor, ok := eventCursor(query); !ok || cursor != 27 {
		t.Fatalf("explicit query cursor = %d, %v", cursor, ok)
	}
	header := httptest.NewRequest(http.MethodGet, "/sse?lastEventId=27", nil)
	header.Header.Set("Last-Event-ID", "31")
	if cursor, ok := eventCursor(header); !ok || cursor != 31 {
		t.Fatalf("native header cursor = %d, %v", cursor, ok)
	}
	for _, raw := range []string{"invalid", "0", "18446744073709551616"} {
		request := httptest.NewRequest(http.MethodGet, "/sse?lastEventId="+raw, nil)
		if cursor, ok := eventCursor(request); ok {
			t.Errorf("invalid cursor %q parsed as %d", raw, cursor)
		}
	}
}
