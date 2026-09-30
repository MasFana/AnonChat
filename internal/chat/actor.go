package chat

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

type command struct {
	kind  string
	data  any
	reply chan response
	ctx   context.Context
}

type response struct {
	value any
	err   *APIError
}

type subscriber struct {
	id          uint64
	anonID      string
	frames      chan []byte
	stopContext func() bool
}

type roomActor struct {
	ref             *roomRef
	limits          Limits
	metrics         *runtimeMetrics
	ownerID         string
	ownerCapability []byte
	createdAt       time.Time
	isPublic        bool
	users           map[string]*User
	messages        MessageRing
	poll            *Poll
	closedPollID    string
	subscribers     map[uint64]*subscriber
	events          EventRing
	seq             uint64
	nextSubscriber  uint64
	ownerTimer      *time.Timer
	ownerTimerID    uint64
	closed          bool
	updateSummary   func(RoomSummary)
	beginClose      func(*roomRef)
	actorExited     func(*roomRef)
}

func newRoomActor(ref *roomRef, ownerID string, capability []byte, limits Limits, metrics *runtimeMetrics, update func(RoomSummary), closeRoom func(*roomRef), exited func(*roomRef)) *roomActor {
	now := time.Now().UTC()
	return &roomActor{
		ref: ref, limits: limits, ownerID: ownerID, ownerCapability: append([]byte(nil), capability...),
		createdAt: now, users: map[string]*User{ownerID: {ID: ownerID, ConnectedAt: now}},
		messages: NewMessageRing(limits.MaxMessagesPerRoom), subscribers: make(map[uint64]*subscriber), metrics: metrics,
		events: NewEventRing(limits.MaxEventRing), updateSummary: update, beginClose: closeRoom, actorExited: exited,
	}
}

func (a *roomActor) run() {
	defer func() {
		if a.ownerTimer != nil {
			a.ownerTimer.Stop()
		}
		for id, sub := range a.subscribers {
			delete(a.subscribers, id)
			if sub.stopContext != nil {
				sub.stopContext()
			}
			close(sub.frames)
		}
		close(a.ref.done)
		a.actorExited(a.ref)
	}()
	a.startOwnerGrace()
	a.publishSummary()
	for !a.closed {
		select {
		case cmd := <-a.ref.commands:
			started := time.Now()
			result := response{}
			if cmd.ctx != nil && cmd.ctx.Err() != nil {
				result = response{err: apiError(503, "timeout")}
			} else {
				result = a.handle(cmd)
			}
			elapsed := uint64(time.Since(started).Nanoseconds())
			a.metrics.roomCommands.Add(1)
			a.metrics.commandLatencyNS.Add(elapsed)
			a.metrics.actorBusyNS.Add(elapsed)
			if cmd.reply != nil {
				cmd.reply <- result
			}
		case subscriberID := <-a.ref.disconnects:
			a.detachSubscriber(subscriberID, true)
		}
	}
}

func (a *roomActor) handle(cmd command) response {
	if a.closed {
		return response{err: errRoomClosed}
	}
	switch cmd.kind {
	case "join":
		return a.join(cmd.data.(string))
	case "meta":
		return response{value: map[string]any{"ownerId": a.ownerID, "isPublic": a.isPublic, "createdAt": a.createdAt}}
	case "state":
		return a.snapshot(cmd.data.(string))
	case "message":
		return a.sendMessage(cmd.data.(messageInput))
	case "visibility":
		return a.setVisibility(cmd.data.(visibilityInput))
	case "poll-create":
		return a.createPoll(cmd.data.(pollInput))
	case "poll-get":
		return response{value: map[string]any{"poll": a.publicPoll()}}
	case "vote":
		return a.vote(cmd.data.(voteInput))
	case "validate-vote":
		return response{err: a.validateVote(cmd.data.(voteInput))}
	case "poll-close":
		return a.closePoll(cmd.data.(pollMutation))
	case "poll-delete":
		return a.deletePoll(cmd.data.(pollMutation))
	case "subscribe":
		return a.subscribe(cmd.data.(subscribeInput))
	case "unsubscribe":
		a.detachSubscriber(cmd.data.(uint64), true)
		return response{}
	case "owner-grace":
		timerID := cmd.data.(uint64)
		if timerID == a.ownerTimerID && a.ownerSubscriptions() == 0 {
			a.deleteRoom()
		}
		return response{}
	case "shutdown":
		a.deleteRoom()
		return response{}
	default:
		return response{err: errUnavailable}
	}
}

func (a *roomActor) join(anonID string) response {
	now := time.Now().UTC()
	a.prunePendingUsers(now)
	if user := a.users[anonID]; user != nil {
		if user.Subscriptions == 0 && anonID != a.ownerID {
			user.PendingUntil = now.Add(30 * time.Second)
		}
	} else {
		if len(a.users) >= a.limits.MaxUsersPerRoom {
			return response{err: apiError(429, "room_full")}
		}
		a.users[anonID] = &User{ID: anonID, ConnectedAt: now, PendingUntil: now.Add(30 * time.Second)}
	}
	return response{value: map[string]any{"joined": true, "ownerId": a.ownerID}}
}

func (a *roomActor) prunePendingUsers(now time.Time) {
	for id, user := range a.users {
		if id != a.ownerID && user.Subscriptions == 0 && !user.PendingUntil.IsZero() && !now.Before(user.PendingUntil) {
			delete(a.users, id)
		}
	}
}

type messageInput struct {
	AnonID  string
	Content string
}

func (a *roomActor) sendMessage(input messageInput) response {
	id, err := randomID()
	if err != nil {
		return response{err: errUnavailable}
	}
	message := Message{ID: id, RoomID: a.ref.id, UserID: input.AnonID, Content: input.Content, CreatedAt: time.Now().UTC()}
	a.messages.Append(message)
	a.metrics.messages.Add(1)
	a.emit("message", message)
	return response{value: map[string]any{"sent": true, "id": id}}
}

type visibilityInput struct {
	AnonID     string
	Capability string
	IsPublic   bool
}

func (a *roomActor) authorize(anonID, capability string) bool {
	if anonID != a.ownerID {
		return false
	}
	provided, err := decodeCapability(capability)
	if err != nil || len(provided) != len(a.ownerCapability) {
		return false
	}
	return subtle.ConstantTimeCompare(provided, a.ownerCapability) == 1
}

func (a *roomActor) setVisibility(input visibilityInput) response {
	if !a.authorize(input.AnonID, input.Capability) {
		return response{err: errForbidden}
	}
	if a.isPublic != input.IsPublic {
		a.isPublic = input.IsPublic
		a.emit("room-visibility", map[string]bool{"isPublic": a.isPublic})
		a.publishSummary()
	}
	return response{value: map[string]any{"ok": true, "isPublic": a.isPublic}}
}

type pollInput struct {
	AnonID     string
	Capability string
	Question   string
	Options    []string
}

func (a *roomActor) createPoll(input pollInput) response {
	if !a.authorize(input.AnonID, input.Capability) {
		return response{err: errForbidden}
	}
	if a.poll != nil {
		return response{err: apiError(409, "poll_active")}
	}
	id, err := randomID()
	if err != nil {
		return response{err: errUnavailable}
	}
	poll := &Poll{ID: id, Question: input.Question, CreatedAt: time.Now().UTC(), Votes: make(map[string]string)}
	poll.Options = make([]PollOption, 0, len(input.Options))
	for _, text := range input.Options {
		optionID, idErr := randomID()
		if idErr != nil {
			return response{err: errUnavailable}
		}
		poll.Options = append(poll.Options, PollOption{ID: optionID, Text: text})
	}
	a.poll = poll
	a.emit("poll", a.publicPoll())
	return response{value: map[string]string{"pollId": poll.ID}}
}

type voteInput struct {
	AnonID   string
	PollID   string
	OptionID string
}

func (a *roomActor) vote(input voteInput) response {
	if apiErr := a.validateVote(input); apiErr != nil {
		return response{err: apiErr}
	}
	option := a.findOption(input.OptionID)
	previous := a.poll.Votes[input.AnonID]
	if previous != input.OptionID {
		if previous != "" {
			if old := a.findOption(previous); old != nil && old.Votes > 0 {
				old.Votes--
			}
		}
		option.Votes++
		a.poll.Votes[input.AnonID] = input.OptionID
		a.metrics.pollVotes.Add(1)
	}
	payload := map[string]any{
		"pollId": a.poll.ID, "anonId": input.AnonID, "optionId": input.OptionID,
		"options": a.poll.Options,
	}
	a.emit("vote", payload)
	return response{value: map[string]bool{"ok": true}}
}

func (a *roomActor) validateVote(input voteInput) *APIError {
	if a.poll == nil {
		if input.PollID == a.closedPollID {
			return apiError(409, "poll_closed")
		}
		return apiError(404, "poll_not_found")
	}
	if a.poll.ID != input.PollID {
		return apiError(404, "poll_not_found")
	}
	option := a.findOption(input.OptionID)
	if option == nil {
		return apiError(400, "invalid_vote")
	}
	previous := a.poll.Votes[input.AnonID]
	if previous == "" && len(a.poll.Votes) >= a.limits.MaxUsersPerRoom {
		return apiError(400, "invalid_vote")
	}
	return nil
}

func (a *roomActor) findOption(id string) *PollOption {
	if a.poll == nil {
		return nil
	}
	for index := range a.poll.Options {
		if a.poll.Options[index].ID == id {
			return &a.poll.Options[index]
		}
	}
	return nil
}

type pollMutation struct {
	AnonID     string
	Capability string
	PollID     string
}

func (a *roomActor) closePoll(input pollMutation) response {
	if !a.authorize(input.AnonID, input.Capability) {
		return response{err: errForbidden}
	}
	if a.poll == nil || a.poll.ID != input.PollID {
		return response{err: apiError(404, "poll_not_found")}
	}
	a.closedPollID = a.poll.ID
	a.poll = nil
	a.emit("poll", nil)
	return response{value: map[string]bool{"ok": true}}
}

func (a *roomActor) deletePoll(input pollMutation) response {
	if !a.authorize(input.AnonID, input.Capability) {
		return response{err: errForbidden}
	}
	if a.poll != nil && a.poll.ID == input.PollID {
		a.closedPollID = ""
		a.poll = nil
		a.emit("poll", nil)
	} else if a.closedPollID == input.PollID {
		a.closedPollID = ""
	}
	return response{value: map[string]any{"ok": true, "deleted": true}}
}

func (a *roomActor) publicPoll() *Poll {
	if a.poll == nil {
		return nil
	}
	copyPoll := *a.poll
	copyPoll.Votes = nil
	copyPoll.Options = append([]PollOption(nil), a.poll.Options...)
	return &copyPoll
}

func (a *roomActor) snapshot(anonID string) response {
	var myVote any
	if a.poll != nil {
		if optionID, exists := a.poll.Votes[anonID]; exists {
			myVote = optionID
		}
	}
	return response{value: map[string]any{
		"users": a.usersPayload(), "messages": a.messages.Snapshot(), "owner": a.ownerID,
		"poll": a.publicPoll(), "myVote": myVote, "isPublic": a.isPublic,
	}}
}

func (a *roomActor) usersPayload() []User {
	users := make([]User, 0, len(a.users))
	for _, user := range a.users {
		if user.Subscriptions > 0 {
			users = append(users, User{ID: user.ID, ConnectedAt: user.ConnectedAt})
		}
	}
	return users
}

func (a *roomActor) publishSummary() {
	active := 0
	for _, user := range a.users {
		if user.Subscriptions > 0 {
			active++
		}
	}
	owner := a.users[a.ownerID]
	a.updateSummary(RoomSummary{
		ID: a.ref.id, CreatedAt: a.createdAt, UserCount: active, SubscriberCount: len(a.subscribers),
		HasOwner: owner != nil && owner.Subscriptions > 0, IsPublic: a.isPublic,
	})
}

func (a *roomActor) ownerSubscriptions() uint16 {
	if user := a.users[a.ownerID]; user != nil {
		return user.Subscriptions
	}
	return 0
}

func (a *roomActor) startOwnerGrace() {
	if a.ownerTimer != nil {
		a.ownerTimer.Stop()
	}
	a.ownerTimerID++
	timerID := a.ownerTimerID
	a.ownerTimer = time.AfterFunc(a.limits.OwnerGrace, func() {
		select {
		case a.ref.commands <- command{kind: "owner-grace", data: timerID}:
		case <-a.ref.done:
		}
	})
}

type subscribeInput struct {
	AnonID    string
	Cursor    uint64
	HasCursor bool
	Context   context.Context
}

func (a *roomActor) subscribe(input subscribeInput) response {
	if len(a.subscribers) >= a.limits.MaxSubscribers || (input.AnonID != a.ownerID && len(a.subscribers) >= a.limits.MaxSubscribers-1) {
		return response{err: errOverloaded}
	}
	a.prunePendingUsers(time.Now().UTC())
	user := a.users[input.AnonID]
	if user == nil {
		if len(a.users) >= a.limits.MaxUsersPerRoom {
			return response{err: apiError(429, "room_full")}
		}
		user = &User{ID: input.AnonID, ConnectedAt: time.Now().UTC()}
		a.users[input.AnonID] = user
	}
	if user.Subscriptions >= uint16(a.limits.MaxSubscriptionsPerUser) {
		return response{err: errOverloaded}
	}
	wasOffline := user.Subscriptions == 0
	user.PendingUntil = time.Time{}
	if input.HasCursor {
		a.metrics.sseReconnects.Add(1)
	}
	user.Subscriptions++
	if input.AnonID == a.ownerID && a.ownerTimer != nil {
		a.ownerTimer.Stop()
		a.ownerTimer = nil
		a.ownerTimerID++
	}
	if wasOffline {
		a.emit("users", a.usersPayload())
		a.publishSummary()
	}

	var initial [][]byte
	if input.HasCursor {
		replay, ok := a.events.ReplayAfter(input.Cursor, a.seq)
		if ok && len(replay) <= a.limits.MaxSSEQueueFrames {
			a.metrics.sseReplay.Add(1)
			initial = make([][]byte, len(replay))
			for index := range replay {
				initial[index] = replay[index].Data
			}
		}
	}
	if initial == nil {
		a.metrics.sseSnapshots.Add(1)
		frame, err := a.frame("snapshot", a.seq, map[string]any{
			"users": a.usersPayload(), "messages": a.messages.Snapshot(), "owner": a.ownerID,
			"poll": a.publicPoll(), "myVote": a.myVote(input.AnonID), "isPublic": a.isPublic,
		})
		if err != nil {
			a.rollbackSubscription(user)
			return response{err: errUnavailable}
		}
		initial = [][]byte{frame}
	}
	a.nextSubscriber++
	sub := &subscriber{id: a.nextSubscriber, anonID: input.AnonID, frames: make(chan []byte, a.limits.MaxSSEQueueFrames)}
	for _, frame := range initial {
		sub.frames <- frame
	}
	a.subscribers[sub.id] = sub
	if input.Context != nil {
		sub.stopContext = context.AfterFunc(input.Context, func() {
			select {
			case a.ref.disconnects <- sub.id:
			case <-a.ref.done:
			}
		})
	}
	a.metrics.sseActive.Add(1)
	a.publishSummary()
	return response{value: sub}
}

func (a *roomActor) myVote(anonID string) any {
	if a.poll == nil {
		return nil
	}
	if optionID, ok := a.poll.Votes[anonID]; ok {
		return optionID
	}
	return nil
}

func (a *roomActor) rollbackSubscription(user *User) {
	if user.Subscriptions > 0 {
		user.Subscriptions--
	}
	if user.Subscriptions == 0 && user.ID != a.ownerID {
		delete(a.users, user.ID)
	}
}

func (a *roomActor) detachSubscriber(id uint64, notify bool) {
	sub := a.subscribers[id]
	if sub == nil {
		return
	}
	if sub.stopContext != nil {
		sub.stopContext()
	}
	delete(a.subscribers, id)
	a.metrics.sseActive.Add(-1)
	close(sub.frames)
	user := a.users[sub.anonID]
	if user == nil || user.Subscriptions == 0 {
		a.publishSummary()
		return
	}
	user.Subscriptions--
	if user.Subscriptions > 0 {
		a.publishSummary()
		return
	}
	if sub.anonID == a.ownerID {
		a.startOwnerGrace()
	} else {
		delete(a.users, sub.anonID)
	}
	if notify {
		a.emit("users", a.usersPayload())
	}
	a.publishSummary()
}

func (a *roomActor) emit(eventType string, payload any) {
	if a.seq == ^uint64(0) {
		a.deleteRoom()
		return
	}
	a.seq++
	frame, err := a.frame(eventType, a.seq, payload)
	if err != nil {
		return
	}
	if a.events.Len() == len(a.events.items) {
		a.metrics.eventRingOverflow.Add(1)
	}
	a.events.Append(Event{Seq: a.seq, Type: eventType, Data: frame})
	a.metrics.events.Add(1)
	var slow []uint64
	for id, sub := range a.subscribers {
		select {
		case sub.frames <- frame:
		default:
			slow = append(slow, id)
		}
	}
	subscriberChanged := false
	presenceChanged := false
	for _, id := range slow {
		sub := a.subscribers[id]
		if sub == nil {
			continue
		}
		delete(a.subscribers, id)
		if sub.stopContext != nil {
			sub.stopContext()
		}
		a.metrics.sseActive.Add(-1)
		a.metrics.sseSlowDisconnects.Add(1)
		close(sub.frames)
		if user := a.users[sub.anonID]; user != nil && user.Subscriptions > 0 {
			user.Subscriptions--
			subscriberChanged = true
			if user.Subscriptions == 0 {
				presenceChanged = true
				if sub.anonID == a.ownerID {
					a.startOwnerGrace()
				} else {
					delete(a.users, sub.anonID)
				}
			}
		}
	}
	if presenceChanged && !a.closed {
		a.emit("users", a.usersPayload())
	}
	if subscriberChanged {
		a.publishSummary()
	}
}

func (a *roomActor) frame(eventType string, seq uint64, payload any) ([]byte, error) {
	data, err := json.Marshal(struct {
		Type    string `json:"type"`
		Seq     uint64 `json:"seq"`
		Payload any    `json:"payload"`
	}{eventType, seq, payload})
	if err != nil {
		return nil, err
	}
	return []byte(fmt.Sprintf("id: %d\nevent: %s\ndata: %s\n\n", seq, eventType, data)), nil
}

func (a *roomActor) ping() []byte { return []byte(": ping\n\n") }

func (a *roomActor) deleteRoom() {
	if a.closed {
		return
	}
	a.beginClose(a.ref)
	a.closed = true
	if a.ownerTimer != nil {
		a.ownerTimer.Stop()
		a.ownerTimer = nil
	}
	a.seq++
	if frame, err := a.frame("room-deleted", a.seq, map[string]string{"roomId": a.ref.id}); err == nil {
		if a.events.Len() == len(a.events.items) {
			a.metrics.eventRingOverflow.Add(1)
		}
		a.events.Append(Event{Seq: a.seq, Type: "room-deleted", Data: frame})
		a.metrics.events.Add(1)
		for id, sub := range a.subscribers {
			select {
			case sub.frames <- frame:
			default:
			}
			delete(a.subscribers, id)
			if sub.stopContext != nil {
				sub.stopContext()
			}
			a.metrics.sseActive.Add(-1)
			close(sub.frames)
		}
	}
}

func call(ctx context.Context, ref *roomRef, kind string, data any) (any, *APIError) {
	cmd := command{kind: kind, data: data, reply: make(chan response, 1), ctx: ctx}
	select {
	case <-ref.done:
		return nil, errRoomClosed
	case <-ctx.Done():
		return nil, apiError(503, "timeout")
	case ref.commands <- cmd:
	default:
		return nil, errOverloaded
	}
	select {
	case result := <-cmd.reply:
		return result.value, result.err
	case <-ref.done:
		select {
		case result := <-cmd.reply:
			return result.value, result.err
		default:
			return nil, errRoomClosed
		}
	case <-ctx.Done():
		return nil, apiError(503, "timeout")
	}
}

func invoke(ref *roomRef, kind string, data any) (any, *APIError) {
	return call(context.Background(), ref, kind, data)
}

func apiErrorFrom(err error) *APIError {
	var typed *APIError
	if errors.As(err, &typed) {
		return typed
	}
	return errUnavailable
}

func validateAnonID(value string) bool {
	if strings.HasPrefix(value, "anon-") && len(value) == 15 {
		for _, char := range value[5:] {
			if (char < 'a' || char > 'z') && (char < '0' || char > '9') {
				return false
			}
		}
		return true
	}
	if !strings.HasPrefix(value, "anon-") || len(value) != 41 {
		return false
	}
	for index, char := range value[5:] {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			if char != '-' {
				return false
			}
			continue
		}
		if (char < 'a' || char > 'f') && (char < '0' || char > '9') {
			return false
		}
	}
	return value[19] == '4' && strings.ContainsRune("89ab", rune(value[24]))
}
