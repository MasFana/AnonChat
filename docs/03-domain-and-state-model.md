# 03 Domain and State Model

This document defines actor-owned in-memory state. No structure escapes actor mutable.

```go
type Room struct {
 ID, OwnerID string; OwnerCapability []byte; CreatedAt time.Time; IsPublic bool
 Users map[string]*User; Messages MessageRing; Poll *Poll
 Subs map[uint64]*Subscriber
 Events EventRing; NextSeq uint64; ownerGrace Timer; Commands chan Command
}
type User struct { ID string; ConnectedAt time.Time; Subscriptions uint16; PendingUntil time.Time }
type Poll struct { ID, Question string; Options []PollOption; Votes map[string]string; CreatedAt time.Time }
type PollOption struct { ID, Text string; Votes uint32 }
type Subscriber struct { ID uint64; AnonID string; Frames chan []byte }
type Event struct { Seq uint64; Type string; Data []byte }
```

## Rings

`MessageRing` allocates exactly `MAX_MESSAGES_PER_ROOM` slots. Append writes index `(start+len)%capacity`; if full, overwrite `start` then advance `start`. Snapshot copies oldest to newest. Empty has no oldest/newest; full backing array never grows. Message IDs are generated at append.

`EventRing` separately allocates exactly `MAX_EVENT_RING` slots. It stores encoded replayable SSE events only, ordered by sequence, with same overwrite/copy rules. It is not message history. `ReplayAfter(n)` succeeds only if `n` is retained/current boundary; returns strictly increasing events where `Seq>n`, else gap. Snapshot copy cannot alias ring backing storage.

## Invariants

1. Actor alone reads/writes room fields, except writer reads immutable bytes received through subscriber queue.
2. `Users` count never exceeds `MAX_USERS_PER_ROOM`; every user has subscription count >=0.
3. Owner online iff owner exists and `Subscriptions>0`.
   A joined user without an SSE subscription is a pending reservation expiring within 30 seconds and is not included in presence.
4. `Messages.Len() <= MAX_MESSAGES_PER_ROOM`; chronological snapshots contain each retained message once.
5. `Events.Len() <= MAX_EVENT_RING`; replayable sequences strictly increase exactly once per mutation.
6. One active `Poll` or nil. Every `Votes[anonID]` names existing option. Each option counter equals number of vote-map entries naming it.
7. Owner-only mutations require `anonId == OwnerID` and a constant-time match of `OwnerCapability`. Capability bytes never enter public state or events.
8. Subscriber count and every `Frames` queue are bounded. Frame enqueue never blocks actor; full queue closes/removes subscriber.
9. Closing state accepts no domain mutation; terminal room-deleted event emits once.

## Signal status

Signals are excluded from this build. Both signal routes return `404 signal_disabled`; room actors hold no signal state. Reconsider only with shipped WebRTC frontend use.

## Identity

`anonId` identifies participant only. It is caller supplied and permits impersonation. Creation generates an unguessable owner capability and returns it once. Owner mutations require both owner ID and capability; actor compares capability in constant time. Client stores capability in `sessionStorage` keyed by room ID. No recovery exists after loss; add accounts or server-side sessions only when recovery or cross-device ownership is needed.
