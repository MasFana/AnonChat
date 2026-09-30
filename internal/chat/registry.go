package chat

import (
	"log/slog"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

type RoomSummary struct {
	ID              string    `json:"id"`
	CreatedAt       time.Time `json:"createdAt"`
	UserCount       int       `json:"userCount"`
	SubscriberCount int       `json:"-"`
	HasOwner        bool      `json:"hasOwner"`
	IsPublic        bool      `json:"-"`
}

type roomRef struct {
	id          string
	commands    chan command
	disconnects chan uint64
	done        chan struct{}
	leases      atomic.Int64
	closing     bool
}

type registry struct {
	mu        sync.RWMutex
	active    map[string]*roomRef
	closing   map[string]*roomRef
	summaries map[string]RoomSummary
	limits    Limits
	draining  bool
	metrics   *runtimeMetrics
}

func newRegistry(limits Limits) *registry {
	return &registry{
		active: make(map[string]*roomRef), closing: make(map[string]*roomRef),
		summaries: make(map[string]RoomSummary), limits: limits, metrics: &runtimeMetrics{},
	}
}

func (r *registry) create(ownerID string) (string, string, string, *APIError) {
	capability, err := newOwnerCapability()
	if err != nil {
		return "", "", "", errUnavailable
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.draining {
		return "", "", "", errUnavailable
	}
	if len(r.active) >= r.limits.MaxRooms {
		return "", "", "", apiError(503, "capacity_exhausted")
	}
	var id string
	for attempt := 0; attempt < 4; attempt++ {
		id, err = randomID()
		if err != nil {
			return "", "", "", errUnavailable
		}
		if r.active[id] == nil && r.closing[id] == nil {
			break
		}
		id = ""
	}
	if id == "" {
		return "", "", "", errUnavailable
	}
	ref := &roomRef{
		id: id, commands: make(chan command, r.limits.MaxCommandQueue),
		disconnects: make(chan uint64, r.limits.MaxSubscribers), done: make(chan struct{}),
	}
	r.active[id] = ref
	actor := newRoomActor(ref, ownerID, capability, r.limits, r.metrics, r.updateSummary, r.beginClose, r.actorExited)
	go actor.run()
	slog.Info("room created", "room_id", id)
	return id, ownerID, encodeCapability(capability), nil
}

func (r *registry) checkCapacity() *APIError {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.draining {
		return errUnavailable
	}
	if len(r.active) >= r.limits.MaxRooms {
		return apiError(503, "capacity_exhausted")
	}
	return nil
}

func (r *registry) acquire(id string) (*roomRef, *APIError) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.draining {
		return nil, errUnavailable
	}
	if ref := r.active[id]; ref != nil && !ref.closing {
		ref.leases.Add(1)
		return ref, nil
	}
	if r.closing[id] != nil {
		return nil, errRoomClosed
	}
	return nil, errRoomNotFound
}

func (r *registry) release(ref *roomRef) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if ref.leases.Load() > 0 {
		ref.leases.Add(-1)
	}
	r.cleanupClosing(ref)
}

func (r *registry) beginClose(ref *roomRef) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.active[ref.id] != ref {
		return
	}
	ref.closing = true
	delete(r.active, ref.id)
	delete(r.summaries, ref.id)
	r.closing[ref.id] = ref
	slog.Info("room closing", "room_id", ref.id)
}

func (r *registry) actorExited(ref *roomRef) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.cleanupClosing(ref)
}

func (r *registry) cleanupClosing(ref *roomRef) {
	if ref.closing && ref.leases.Load() == 0 {
		if r.closing[ref.id] == ref {
			delete(r.closing, ref.id)
		}
	}
}

func (r *registry) updateSummary(summary RoomSummary) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if ref := r.active[summary.ID]; ref != nil && !ref.closing {
		r.summaries[summary.ID] = summary
	}
}

type RoomList struct {
	Rooms []RoomSummary `json:"rooms"`
	Stats struct {
		TotalRooms        int `json:"totalRooms"`
		ActiveUsers       int `json:"activeUsers"`
		OwnersOnline      int `json:"ownersOnline"`
		SubscribersOnline int `json:"-"`
	} `json:"stats"`
}

func (r *registry) list() RoomList {
	r.mu.RLock()
	result := RoomList{Rooms: make([]RoomSummary, 0, 100)}
	result.Stats.TotalRooms = len(r.active)
	for _, summary := range r.summaries {
		result.Stats.ActiveUsers += summary.UserCount
		result.Stats.SubscribersOnline += summary.SubscriberCount
		if summary.HasOwner {
			result.Stats.OwnersOnline++
		}
		if summary.IsPublic {
			result.Rooms = append(result.Rooms, summary)
		}
	}
	r.mu.RUnlock()
	sort.Slice(result.Rooms, func(i, j int) bool {
		return result.Rooms[i].CreatedAt.After(result.Rooms[j].CreatedAt)
	})
	if len(result.Rooms) > 100 {
		result.Rooms = result.Rooms[:100]
	}
	return result
}

func (r *registry) markDraining() []*roomRef {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.draining = true
	refs := make([]*roomRef, 0, len(r.active))
	for _, ref := range r.active {
		refs = append(refs, ref)
	}
	return refs
}
