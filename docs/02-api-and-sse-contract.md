# 02 API and SSE Contract

This document is sole public HTTP/SSE definition. JSON errors use `{"error":"<stable-code>"}` unless noted. IDs are opaque URL-safe generated strings; no client may assume format except `anonId` is `anon-` plus ten lowercase alphanumerics.

## HTTP

| Method/path | Request and validation | Success | Errors | Events |
|---|---|---|---|---|
| `GET /api/anon` | none | `200 {"anonId"}` | � | � |
| `POST /api/room` | `{anonId}` valid anon ID | `200 {roomId,ownerId,ownerCapability}` | `400 invalid_anon_id`; `429 rate_limited`; `503 capacity_exhausted` | none |
| `GET /api/room` | none | `200 {rooms:[{id,createdAt,userCount,hasOwner}],stats:{totalRooms,activeUsers,ownersOnline}}` | `503 unavailable` | none |
| `POST /api/room/:id/join` | `{anonId}`, valid, <=64 bytes | `200 {joined:true,ownerId}` | `400 invalid_anon_id`; `404 room_not_found`; `410 room_closed`; `429 rate_limited` or `room_full`; `503 overloaded` | `users` on new user/presence change |
| `POST /api/room/:id/message` | `{anonId,content}`; valid ID; trimmed nonempty UTF-8 <=65536 bytes | `200 {sent:true,id}` | `400 invalid_message`; room errors; `429 rate_limited`; `503 overloaded` | `message` |
| `GET /api/room/:id/meta` | none | `200 {ownerId,isPublic,createdAt}` | `404 room_not_found`; `410 room_closed` | none |
| `PATCH /api/room/:id/visibility` | `{anonId,ownerCapability,isPublic:boolean}`; owner capability | `200 {ok:true,isPublic}` | `400 invalid_payload`; `403 forbidden`; room errors | `room-visibility` |
| `POST /api/room/:id/poll` | `{anonId,ownerCapability,question,options}`; owner capability; 2..8 nonempty options; bounded strings | `200 {pollId}` | `400 invalid_poll`; `403 forbidden`; `409 poll_active`; room errors | `poll` |
| `GET /api/room/:id/poll` | none | `200 {poll: Poll|null}` | room errors | none |
| `POST /api/room/:id/poll/:pollId` | `{anonId,optionId}`; active poll and option exist | `200 {ok:true}` | `400 invalid_vote`; `404 poll_not_found`; `409 poll_closed`; room errors; `429 rate_limited` | `vote` |
| `PATCH /api/room/:id/poll/:pollId` | `{anonId,ownerCapability,active:false}`; owner capability | `200 {ok:true}` | `400 invalid_payload`; `403 forbidden`; `404 poll_not_found`; room errors | `poll` |
| `DELETE /api/room/:id/poll/:pollId` | `{anonId,ownerCapability}`; owner capability | `200 {ok:true,deleted:true}` | `400 invalid_anon_id`; `403 forbidden`; room errors | `poll` |
| `POST /api/room/:id/signal` | disabled | — | `404 signal_disabled` | none |
| `GET /api/room/:id/signal?for=` | disabled | — | `404 signal_disabled` | none |
| `GET /api/room/:id/state` | `anonId` query valid | `200` snapshot payload | `400 invalid_anon_id`; room errors | none |
| `GET /api/room/:id/sse?anonId=` | valid query ID | stream | `400` text `Missing anonId`; `404` text `Room not found`; `410` text `Room closed`; `429 rate_limited`; `503 overloaded` | stream |

`/state` is compatibility snapshot only. It has no presence/deletion side effect. Frontend uses SSE snapshot/replay.

**INTENTIONAL CHANGE:** poll APIs expose only nullable active `poll`, not historical `polls`; setting `active:true` and reopening are unsupported.

`ownerCapability` is an opaque, unguessable bearer credential returned only by room creation. It is required for every owner-only mutation and must never be returned by later APIs, SSE, or logs. Store it in browser `sessionStorage` keyed by room ID. Loss has no recovery path in anonymous mode.

Signal routes deliberately remain disabled. A future WebRTC feature must define and ship its frontend consumer before adding public signal semantics.

## SSE

Connection: `GET /api/room/:id/sse?anonId=<anonId>`. Server sends:

```http
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

Disable response compression. Writer flushes every frame through `http.Flusher`. Proxies must disable buffering and allow idle stream traffic; `ping` arrives each 15 seconds.

Replayable frames have exact shape:

```text
id: 124
event: message
data: {"type":"message","seq":124,"payload":{...}}

```

Vocabulary: `snapshot`, `message`, `users`, `poll`, `vote`, `room-visibility`, `room-deleted`, `ping`. `ping` is non-replayable, has no `id`, and does not change state. Every other event is replayable and has room-local monotonically increasing unsigned sequence.

### Payloads
- `snapshot`: `{"type":"snapshot","seq":N,"payload":{"users":[],"messages":[],"owner":"...","poll":null|Poll,"myVote":null|string,"isPublic":false}}`.
- `message`: `{id,roomId,userId,content,createdAt}`.
- `users`: `[{id,connectedAt}]`.
- `poll`: `Poll|null`; `null` means closed/deleted.
- `vote`: `{pollId,anonId,optionId,options:[{id,text,votes}]}`. Client derives own selection where `anonId` equals local ID.
- `room-visibility`: `{isPublic}`.
- `room-deleted`: `{roomId}`; stream closes after terminal frame.

`Poll` is `{id,question,options:[{id,text,votes}],createdAt}`. Timestamps RFC3339 UTC.

### Snapshot and replay
Actor subscription command atomically decides and installs subscriber:
1. No valid `Last-Event-ID`: capture state and current `seq=N`, enqueue snapshot first, then subscribe for later events.
2. Valid `Last-Event-ID=N` retained by EventRing: enqueue every replayable event with `seq>N` in order, then subscribe. No snapshot.
3. Missing, malformed, future, or older-than-oldest cursor: capture snapshot boundary and enqueue snapshot first, then subscribe.

Actor performs capture/replay selection, queue insertion, and subscriber registration in one command. Later mutation has higher sequence and follows queued snapshot/replay. Client stores greatest received ID, ignores any replayable event with `seq <= lastApplied`, and resets state only on snapshot. Native `EventSource` sends `Last-Event-ID` after an `id:` frame; client must retain last ID for explicit reconnect construction if needed.

Event ring overflow discards oldest event. Cursor that cannot prove complete replay gets snapshot, never partial replay. Queue full disconnects subscriber; no arbitrary event drop. Reconnect then replays or snapshots consistent state.
