# 05 Limits, Performance and Test Plan

## Admission and rate limits

Defaults and entity limits are in `01`; validate before allocation. Local token buckets cover room creation per IP, join per IP+room, messages per anon+room, votes per anon+room, and SSE attempts per IP+room. Actor commands also have budgets of 300/IP/minute globally and 120/IP+room/minute. Messages and votes have coarse budgets of 200/IP/minute globally and 100/IP+room/minute, so caller-supplied anon IDs or many room IDs cannot exhaust limiter keys from one address. IPv6 limiter identities aggregate at /64. Limiter map has idle expiry (10 minutes), periodic cleanup, and configurable `MAX_RATE_LIMIT_KEYS=10000` (hard maximum 100,000); when key capacity is full, reject unknown keys with `429 rate_limited`. Trust forwarded IP only behind configured trusted proxy CIDRs. A join without SSE presence expires as a pending reservation after 30 seconds.

## Capacity model

Initial planning shape: 1,000 rooms; 1,000 users max/room; 1,000 messages � <=1,000 bytes; 256 encoded event frames; 32 subscribers � 32 frames; four connections per anon ID with one slot reserved for the owner; one poll with <=1,000 vote entries. Actual heap includes maps, strings, encoded frames, goroutine stacks, JSON, and runtime overhead. Do not publish capacity guarantee. Benchmark on deployment hardware, choose container memory with headroom, set `GOMEMLIMIT` below cgroup limit, and reject before saturation.

## Performance tradeoff and gates

Actor serialization gives simple ordering/atomicity. Hot room throughput is limited by one actor and O(subscribers) enqueue. Do not shard before evidence. Record `room_command_latency`, `room_command_queue_depth`, `actor_busy_time`, `events_per_second`, `SSE fanout latency`, HTTP latency, SSE latency, heap/RSS, GC, CPU, goroutines.

Initial test gates, not promises: normal-load p99 mutation <100ms; fanout enqueue p99 <50ms at chosen load; RSS <80% container memory; steady-state heap/goroutines no monotonic growth. Calibrate or revise after benchmarks.

## Observability

Use `slog`; log request status/duration and lifecycle/overload events, never message content or owner capabilities. `/healthz` reports process liveness. `/readyz` fails while draining or admission safety threshold breached. Expose metrics: `rooms_active`, `users_active`, `subscribers_active`, `room_commands_total`, `room_command_latency`, `room_command_queue_depth`, `sse_connections`, `sse_reconnects`, `sse_slow_consumer_disconnects`, `sse_replay_total`, `sse_snapshot_total`, `event_ring_overflow`, `messages_total`, `poll_votes_total`, `memory_usage`, `goroutines`. JSON, static asset, and SSE frame writes have 10-second deadlines. Pprof is disabled unless `PPROF_TOKEN` is configured and the direct connection is loopback; do not publish it through an untrusted proxy.

## Tests

Unit: message ring, event ring, actor commands, registry leases/capacity, fake lifecycle timers, poll vote transitions, limiter expiry/capacity, subscriber queues.

Property/fuzz: both rings never exceed capacity/backing allocation; ordering and wrap correct; snapshots independent/stable; sequence monotonic; replay returns only greater cursor or gap fallback.

Race: run `go test -race ./...`. Cover concurrent joins/messages/votes; owner capability rejection; delete vs join/subscribe; owner reconnect vs grace; shutdown vs active command; queue-full. Assert no actor/writer leak and no post-delete mutation.

SSE integration: initial snapshot; headers/flushing; IDs and monotonic order; replay; overflow snapshot fallback; snapshot boundary during mutation; dedupe; slow queue close/reconnect; deletion during reconnect; heartbeat; disconnect cleanup.

Load: 100 rooms moderate activity; 1,000 rooms moderate activity; one hot room with many users; one hot room high command rate; many subscribers; slow consumers; reconnect storm; creation burst; memory pressure. Capture p50/p95/p99 HTTP and message-to-SSE latency, errors, replay/snapshot counts, queue disconnects, heap/RSS, GC, goroutines, CPU, block/mutex profiles.

Run `go test ./...`, `go test -race ./...`, `go test -bench=. -benchmem ./...`; browser smoke tests `/`, room creation, `/room/:id` deep link, SSE message/poll update, reconnect, and missing asset/API routing.
