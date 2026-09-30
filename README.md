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
| `MAX_SUBSCRIBERS_PER_ROOM`   |       32 |
| `MAX_SUBSCRIPTIONS_PER_USER` |        4 |
| `MAX_SSE_QUEUE_FRAMES`       |       32 |
| `MAX_ROOM_COMMAND_QUEUE`     |      256 |
| `MAX_MESSAGE_BYTES`          |     1000 |
| `MAX_REQUEST_BODY_BYTES`     |     8192 |
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
