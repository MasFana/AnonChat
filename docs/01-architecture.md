# 01 Architecture

## Goals

One Go process serves static React SPA and `/api/*` over `net/http`. All application state exists only in process memory. Browser uses HTTP and SSE, same origin.

## Non-goals

Persistence, recovery, databases, external cache/event bus, replicas, horizontal scaling, global room-list SSE. Restart creates empty registry and destroys every room, user, message, poll, signal, and SSE connection.

```text
Browser -- HTTP + SSE --> Go net/http --> Registry --> Room actor --> SSE queues
                                   �                 users/messages/poll/events
                                   +--------------> embedded web/dist
```

## Ownership

`Registry = existence/lifecycle of actors.` It owns `map[string]*RoomRef`, capacity, leases, actor startup/removal, and lightweight public-room summaries. It never owns business state and never closes an actor command channel.

`Room actor = state/behavior of one room.` One goroutine exclusively owns all room metadata, owner capability, users, visibility, rings, active poll/votes, subscribers, sequence, timers, and deletion state. Handlers only validate, acquire lease, send bounded command, await bounded reply, release lease, and write HTTP response. No handler mutates room state.

## Registry and deletion

`Acquire(id)` under registry read lock rejects absent/closing rooms, increments `RoomRef.leases`, returns actor reference. `Release` decrements lease. Creation holds registry write lock for capacity, collision check, insertion, and actor start.

Only actor starts deletion. It first asks registry to mark matching ref closing and remove map entry. New acquisitions fail. Actor rejects queued/new commands with `room_closed`, emits one replayable `room-deleted`, closes subscriber queues, cancels timers, exits. Registry waits for leases to reach zero, then releases ref. Actor owns command-channel receive loop; command channel is never closed. Therefore no send-on-closed-channel race.

Race result: operation leased before closing either completes before terminal transition or receives `room_closed`; later join/subscribe gets missing/closed response. Grace expiry and owner reconnect are commands serialized by actor; expiry wins only if actor processes it while owner subscription count remains zero. Shutdown marks registry draining before actor stop; active commands receive bounded cancellation/closed response.

## Lifecycle and presence

Presence means active SSE subscription. User has subscription count; multiple browser connections count once for user presence. Join creates/retains a user; disconnect decrements only that subscription. When a non-owner count reaches zero, actor removes that user and emits `users`. When owner count reaches zero, actor retains owner during `OWNER_AWAY_GRACE=5s`; owner reconnect cancels timer. Expiry deletes room. Empty room deletes immediately. `/state`, SSE, and all other endpoints use actor state; none independently deletes rooms.

A join without a subsequent SSE connection is a pending reservation for at most 30 seconds. It is excluded from active presence; the actor lazily prunes expired reservations before join/subscribe admission. This bounds abandoned join state without adding per-user timer goroutines.

## Actor and concurrency

Actor command queue is bounded. Full queue returns overload; handler context/result timeout returns timeout without mutating after handler leaves. Actor serializes mutation, increments per-room sequence, appends replay event, fans out nonblocking, then replies. One hot room is bottleneck by design; many moderate rooms fit well. Measure before partitioning.

## Memory model

Defaults: `MAX_ROOMS=1000`, `MAX_USERS_PER_ROOM=1000`, `MAX_MESSAGES_PER_ROOM=1000`, `MAX_EVENT_RING=256`, `MAX_SUBSCRIBERS_PER_ROOM=32`, `MAX_SUBSCRIPTIONS_PER_USER=4`, `MAX_SSE_QUEUE_FRAMES=32`, `MAX_ROOM_COMMAND_QUEUE=256`, `MAX_MESSAGE_BYTES=1000`, `MAX_REQUEST_BODY_BYTES=8192`, `MAX_POLL_OPTIONS=8`, question/options `256/128` bytes. One subscriber slot is reserved for the owner. All configurable limits stay within validated hard deployment ceilings. Creation at capacity returns `503 capacity_exhausted`; joins at room limit return `429 room_full`.

Message and event rings use preallocated fixed arrays. Subscriber frames dominate: 32 subscribers � 32 frames � bounded encoded frame size. Size limits apply before retaining/enqueueing. `GOMEMLIMIT` is process safety only, not admission control.

## Public list

Registry maintains summaries on actor notifications: ID, creation time, public flag, active user count, owner online. `GET /api/room` returns newest 100 public summaries and aggregate stats. HTTP may cache response 2 seconds.

## Static serving

Build React into `web/dist`; embed with `go:embed`. Runtime needs no Node. `/api/*` goes only API handlers. Exact assets serve files; immutable hashed assets cache long. Missing hashed asset returns 404. GET/HEAD non-API unknown routes, including `/room/:id`, return SPA shell. No API or asset fallback.

## Shutdown

SIGTERM marks unready/draining, stops new room creation and SSE admission, calls HTTP shutdown, asks actors to stop, waits bounded time, then exits. Optional terminal shutdown frame is best effort. State is not saved: restart is empty application.

## Scaling boundary

Single process, one registry, one actor set, one SSE space. Horizontal scaling unsupported. Reverse proxy may forward to this one process only.

## Architecture Decision Summary

```text
Runtime:
    Go
HTTP:
    net/http
State:
    process memory
Persistence:
    none
Database:
    none
Event bus:
    room actor + in-memory event ring
Realtime:
    SSE
Frontend:
    static React SPA
Concurrency:
    one actor per room
Scaling:
    single process
Restart:
    all state lost
Horizontal scaling:
    unsupported
Message history:
    bounded ring
Event replay:
    bounded event ring
Polls:
    one active poll
Presence:
    live SSE connection state
Room deletion:
    actor-owned lifecycle
```

### Intentional behavior changes

- **INTENTIONAL CHANGE:** retain last 1000 messages, not 5,000/persistent history.
- **INTENTIONAL CHANGE:** one active poll; close/delete discards poll, votes, and results. No poll history or reopen.
- **INTENTIONAL CHANGE:** SSE has sequence IDs, replay, snapshot fallback, bounded queues; slow consumers disconnect.
- **INTENTIONAL CHANGE:** owner grace applies uniformly; state read cannot bypass it.
- **REMOVED BY IN-MEMORY ARCHITECTURE:** persisted presence, presence loops/write throttles, stale-record TTL, historical rooms/data, persistence migrations.

### Known limitations

`anonId` identifies participants only and is caller supplied. Owner-only mutations require an unguessable owner capability. Browser storage does not protect capability from XSS; lost capability cannot be recovered without adding accounts or server-side sessions. Single actor limits hot-room throughput. Restart invalidates room links.

### Resolved decisions

- **Owner authorization:** creation returns a private unguessable `ownerCapability`; visibility and poll mutations require it with `anonId`. The actor compares it in constant time. It never appears in room metadata, lists, state, SSE, logs, or join responses. Client keeps it in `sessionStorage` keyed by room ID.
- **WebRTC signaling:** not part of this build. No inspected frontend consumer exists. Signal routes return `404 signal_disabled`; no signal state, limits, timers, or actor commands exist.
