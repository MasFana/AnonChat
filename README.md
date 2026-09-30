| `MAX_RATE_LIMIT_KEYS` | 10000 |

# AnonChat

AnonChat is an anonymous chat and live-poll application. A single Go process serves the static React export and the same-origin HTTP/SSE API. Room state is bounded and process-local; restarting the server clears every room.

## Runtime

- Go 1.23 or newer; runtime dependencies are Go standard library only.
- The prebuilt frontend is embedded from `web/dist`. Node.js is needed only when rebuilding the frontend.
- No MongoDB, persistence, WebSocket, or external service is used. Do not run multiple backend replicas.

Run the server from the repository root:

```powershell
go run ./cmd/server
```

The default address is `:8080`. Set `ADDR` to override it. Health and readiness endpoints are `/healthz` and `/readyz`; Prometheus-compatible metrics are at `/metrics`. Standard pprof diagnostics under `/debug/pprof/` require both a configured `PPROF_TOKEN` bearer token and a direct loopback connection.

Build a standalone server:

```powershell
go build -o anonchat.exe ./cmd/server
```

## Configuration

All limits are validated against deployment ceilings at startup. Defaults:

| Variable                     |  Default |
| ---------------------------- | -------: |
| `MAX_ROOMS`                  |     1000 |
| `MAX_USERS_PER_ROOM`         |     1000 |
| `MAX_MESSAGES_PER_ROOM`      |     1000 |
| `MAX_EVENT_RING`             |      256 |
| `MAX_SUBSCRIBERS_PER_ROOM`   |      100 |
| `MAX_SUBSCRIPTIONS_PER_USER` |        4 |
| `MAX_SSE_QUEUE_FRAMES`       |       32 |
| `MAX_ROOM_COMMAND_QUEUE`     |      256 |
| `MAX_MESSAGE_BYTES`          |    65536 |
| `MAX_REQUEST_BODY_BYTES`     |   131072 |
| `MAX_POLL_OPTIONS`           |        8 |
| `OWNER_AWAY_GRACE_MS`        |     5000 |
| `HEARTBEAT_INTERVAL_MS`      |    15000 |
| `TRUSTED_PROXY_CIDRS`        |    empty |
| `PPROF_TOKEN`                | disabled |

`TRUSTED_PROXY_CIDRS` is a comma-separated list of proxy networks. Forwarded client IPs are trusted only when the direct peer matches one of those CIDRs. `example.env` lists the supported settings. Anonymous participant IDs are not credentials; owner mutations require the separate owner capability returned by room creation.

Unconnected join reservations expire after 30 seconds. Message and vote admission combines per-anonymous-ID limits with coarse limits of 200 requests per IP per minute globally and 100 requests per IP per room per minute, bounding caller-controlled limiter keys.

## API

The normative request, response, validation, status, and SSE event contract is [docs/02-api-and-sse-contract.md](docs/02-api-and-sse-contract.md). It includes:

- `GET /api/anon` and `GET|POST /api/room`
- Room join, metadata, visibility, message, state, and active-poll endpoints
- `GET /api/room/:id/sse` with replay, snapshot fallback, heartbeats, and terminal deletion
- Disabled signaling endpoints returning `404 signal_disabled`

Static GET/HEAD requests serve exact embedded assets; `/room/:id` receives the exported room shell. API paths never fall back to HTML, and missing hashed assets return 404.

## Development Checks

```powershell
gofmt -w cmd/server internal/chat web/embed.go
go vet ./...
go test ./...
go test -race ./...
```

For frontend changes, build the static export into `web/dist` before rebuilding the Go binary.

## Realistic load benchmark

Run server and load generator from separate machines when possible. Same host mixes server and generator CPU, RAM, network, and scheduler cost.

Required server environment:

```powershell
$env:MAX_SUBSCRIBERS_PER_ROOM=100
$env:MAX_USERS_PER_ROOM=100
$env:MAX_MESSAGE_BYTES=65536
$env:MAX_REQUEST_BODY_BYTES=131072
$env:PPROF_TOKEN='local-benchmark-token'
$env:BENCHMARK_RATE_LIMIT_MULTIPLIER=100 # benchmark-only; keep 1 in production
go build -o anonchat.exe ./cmd/server
.\anonchat.exe
```

Capture metrics with `Invoke-WebRequest http://127.0.0.1:8080/metrics`. Pprof needs loopback plus bearer token: `Invoke-WebRequest -Headers @{Authorization='Bearer local-benchmark-token'} http://127.0.0.1:8080/debug/pprof/heap?debug=1`. Current global/IP (200/minute) and IP/room (100/minute) rate limits can reject setup or high-rate traffic when callers share one IP. `BENCHMARK_RATE_LIMIT_MULTIPLIER` multiplies every per-minute limiter capacity only for isolated benchmark servers; default `1` preserves production behavior.

Normal traffic:

```powershell
go run ./cmd/loadtest -mode realistic -rooms 10 -participants 50 -messages-per-room-per-second 1 -message-bytes 500 -duration 5m -server-pid <PID>
```

Source-code sharing:

```powershell
go run ./cmd/loadtest -mode realistic -rooms 10 -participants 50 -messages-per-room-per-second 1 -message-bytes 500 -source-message-bytes 32768 -source-message-every 60 -duration 5m -server-pid <PID>
```

Per-user stress:

```powershell
go run ./cmd/loadtest -mode realistic -rooms 10 -participants 50 -sender-mode all -messages-per-room-per-second 1 -message-bytes 500 -duration 1m -server-pid <PID>
```

Output uses stable `key=value` lines. It is measurement from one run, not capacity guarantee. Windows `-server-pid` sampling uses `Get-Process`; unsupported systems print `server_resource_sampling=unsupported`.
