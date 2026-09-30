# AnonChat

Anonymous chat and live-poll app. One Go process serves embedded static Next.js export plus same-origin HTTP/SSE API.

Room state, messages, polls, identities, and SSE connections live only in process memory. Restart deletes all room state. No database, MongoDB, WebSocket, persistence, external cache, or event bus exists. Run exactly one backend replica; horizontal scaling is unsupported.

## Stack and layout

- Go 1.23+: API, SSE, static serving, in-memory room actors.
- Node.js + npm: frontend source and static export build only. Runtime needs no Node.js.
- `src/`: Next.js/React frontend source.
- `web/dist/`: generated static export, embedded by `web/embed.go`.
- `cmd/server/`: production server. `cmd/loadtest/`: load generator.
- `internal/chat/`: HTTP API, SSE, limits, rate limiting, room state.
- `docs/02-api-and-sse-contract.md`: authoritative API and SSE contract.

## Requirements

| Need | Use |
| --- | --- |
| Go 1.23+ | Server, tests, build |
| Node.js current LTS + npm | Frontend changes or rebuild `web/dist` |
| cloudflared | Cloudflare Tunnel only |

## Run local

### Go server with committed frontend

`web/dist` is committed and embedded. From repository root:

```powershell
go run ./cmd/server
```

Open <http://127.0.0.1:8000>. Stop with `Ctrl+C`.

```powershell
Invoke-WebRequest http://127.0.0.1:8000/healthz
Invoke-WebRequest http://127.0.0.1:8000/readyz
Invoke-WebRequest http://127.0.0.1:8000/metrics
```

### Frontend work

Install locked dependencies:

```powershell
npm ci
```

Fast UI work uses throwaway Node mock API. Run both commands in separate terminals:

```powershell
# Terminal 1
node tools/mock-api.mjs

# Terminal 2
npm run dev
```

Open <http://127.0.0.1:3000>. Mock state resets when stopped. Check mock contract:

```powershell
node tools/mock-api-check.mjs
```

For integrated Go API validation, rebuild export then run Go server:

```powershell
npm run build
go run ./cmd/server
```

`npm run dev` is Next.js dev server, not Go backend. Do not deploy `npm run start`; production runtime is Go binary.

## Build

Rebuild frontend after changes in `src/`, `public/`, or frontend config:

```powershell
npm ci
npm run build
```

Next.js writes static export directly to `web/dist` through `next.config.ts`. Go embeds this directory at compile time.

Build local release binary:

```powershell
npm ci
npm run build
go build -trimpath -o .\anonchat.exe ./cmd/server
.\anonchat.exe
```

Example Linux amd64 cross-build from PowerShell:

```powershell
$env:GOOS='linux'; $env:GOARCH='amd64'
go build -trimpath -o .\anonchat ./cmd/server
Remove-Item Env:GOOS, Env:GOARCH
```

## Production

1. Build frontend, then Go binary.
2. Copy values from `example.env` into process/service environment. App does not load `.env` itself.
3. Bind origin to loopback when Cloudflare Tunnel is only public entrypoint.
4. Start exactly one binary instance.
5. Probe `/healthz` and `/readyz` through loopback. Monitor `/metrics` only from trusted network.

Example Windows origin for same-host Cloudflare Tunnel:

```powershell
$env:ADDR='127.0.0.1:8000'
$env:TRUSTED_PROXY_CIDRS='127.0.0.1/32,::1/128'
$env:RATE_LIMIT_MULTIPLIER='1'
.\anonchat.exe
```

`ADDR=127.0.0.1:8000` prevents direct LAN/Internet access. Keep `cloudflared` separate. Do not publicly expose `/debug/pprof/`, `/metrics`, `/healthz`, or `/readyz` without access policy.

`SIGTERM` and `Ctrl+C` mark server unready, drain work, then exit. All state remains lost after stop/restart.

## Configuration

Set OS process/service environment variables. Empty variable uses deployment defaults. `PPROF_TOKEN` remains disabled when empty.

| Variable | Default | Range / purpose |
| --- | ---: | --- |
| `ADDR` | `127.0.0.1:8000` | Loopback listener |
| `TRUSTED_PROXY_CIDRS` | `127.0.0.1/32,::1/128` | Comma-separated direct proxy CIDRs |
| `PPROF_TOKEN` | disabled | Bearer token for loopback-only pprof |
| `MAX_ROOMS` | 1000 | 1–10000 |
| `MAX_USERS_PER_ROOM` | 1000 | 1–10000 |
| `MAX_MESSAGES_PER_ROOM` | 1000 | 1–10000 |
| `MAX_EVENT_RING` | 256 | 1–4096 |
| `MAX_SUBSCRIBERS_PER_ROOM` | 100 | 1–256 |
| `MAX_SUBSCRIPTIONS_PER_USER` | 4 | 1–32 |
| `MAX_SSE_QUEUE_FRAMES` | 32 | 1–256 |
| `MAX_ROOM_COMMAND_QUEUE` | 256 | 1–4096 |
| `MAX_MESSAGE_BYTES` | 65536 | 1–65536 |
| `MAX_REQUEST_BODY_BYTES` | 131072 | 1024–131072 |
| `MAX_POLL_OPTIONS` | 8 | 2–8 |
| `MAX_RATE_LIMIT_KEYS` | 10000 | 100–100000 |
| `RATE_LIMIT_MULTIPLIER` | 10 | 1–1000; multiplies per-minute limits |
| `OWNER_AWAY_GRACE_MS` | 5000 | 100–60000 |
| `HEARTBEAT_INTERVAL_MS` | 15000 | 1000–60000 |

Invalid limits fail startup. `example.env` contains every supported setting.

`TRUSTED_PROXY_CIDRS` is security-sensitive. Forwarded headers, including `CF-Connecting-IP`, are trusted only when direct TCP peer matches this list. For local `cloudflared`, use `127.0.0.1/32,::1/128` and bind app to loopback. Never trust broad Internet ranges or set this while origin is directly reachable by untrusted clients.

Default `RATE_LIMIT_MULTIPLIER=10` favors high traffic. Use `1` for stricter public Internet deployment. Join reservations without SSE expire after 30 seconds. Message/vote coarse limits are 200 requests/IP/minute global and 100 requests/IP/room/minute, multiplied by this setting.

Anonymous IDs identify participants, not credentials. Owner-only changes need private `ownerCapability` returned only at room creation and held in browser `sessionStorage`. Lost capability cannot be recovered.

## Cloudflare Tunnel and cloudflared

Use remotely managed tunnel. Origin makes outbound connection; no inbound port forwarding, public IP, or origin TLS required. Add domain to Cloudflare first.

### 1. Install cloudflared on Windows

Cloudflare dashboard tunnel creation shows current install command. Manual option: download x64 Windows MSI or executable from [Cloudflare downloads](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), install it, then verify:

```powershell
cloudflared --version
```

Windows cloudflared does not auto-update. Update it regularly from official releases.

### 2. Create tunnel and hostname

1. Open Cloudflare Zero Trust dashboard.
2. Go to **Networking** > **Tunnels** > **Create a tunnel**.
3. Choose **Cloudflared**, name tunnel, copy generated connector command containing token.
4. Add route: **Published application**.
5. Choose hostname, example `chat.example.com`.
6. Set **Service URL** to `http://localhost:8000`.
7. Save. Wait for tunnel status **Healthy**.

Path routing does not strip path. Use root hostname; app needs `/api/*`, `/room/*`, and `/_next/*` unchanged.

### 3. Start origin and connector

Terminal/service 1:

```powershell
$env:ADDR='127.0.0.1:8000'
$env:TRUSTED_PROXY_CIDRS='127.0.0.1/32,::1/128'
$env:RATE_LIMIT_MULTIPLIER='1'
.\anonchat.exe
```

Terminal/service 2. Replace token from dashboard:

```powershell
cloudflared tunnel run --token '<TUNNEL_TOKEN>'
```

Tunnel token grants connector access. Store it in Windows service secret/environment manager. Never commit, screenshot, or place it in tracked `.env`. Rotate/revoke token in Cloudflare dashboard.

For persistent Windows deployment, use dashboard-provided service install command or Windows Service Manager for `cloudflared`, and supervise one `anonchat.exe` process. Both should restart on failure. Do not run multiple AnonChat processes.

### 4. Verify external traffic and SSE

```powershell
Invoke-WebRequest https://chat.example.com/healthz
Invoke-WebRequest https://chat.example.com/
```

Open room in two browsers/devices. Messages and presence must update live. SSE is `GET /api/room/:id/sse`; tunnel forwards it. Do not add proxy buffering or response compression before origin. SSE heartbeat follows `HEARTBEAT_INTERVAL_MS`.

Optional: protect hostname with Cloudflare Access. Test room creation, join, messages, polls, and live SSE after policy changes.

References: [Cloudflare dashboard tunnel guide](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/) and [cloudflared downloads](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).

## Operations

- `GET /healthz`: process alive, `200 ok`.
- `GET /readyz`: accepts new rooms/SSE, `503` while draining or room capacity full.
- `GET /metrics`: Prometheus-compatible plain text.
- `/debug/pprof/`: direct loopback only, no forwarded headers, `Authorization: Bearer <PPROF_TOKEN>` required.

```powershell
$env:PPROF_TOKEN='local-debug-token'
go run ./cmd/server
# Separate terminal:
Invoke-WebRequest -Headers @{ Authorization = 'Bearer local-debug-token' } http://127.0.0.1:8000/debug/pprof/heap?debug=1
```

Never route pprof through Cloudflare Tunnel: forwarded headers intentionally disable it.

## Validate

```powershell
npm ci
npm run lint
npm run build
gofmt -w cmd/server cmd/loadtest internal/chat web/embed.go
go vet ./...
go test ./...
go test -race ./...
```

`gofmt -w` changes files when needed. Check `git diff --check` and `git status` before commit.

## Load benchmark

Run server and generator on separate machines when possible. Same host mixes CPU, memory, network, scheduler cost.

Isolated benchmark server only:

```powershell
$env:MAX_SUBSCRIBERS_PER_ROOM=100
$env:MAX_USERS_PER_ROOM=100
$env:MAX_MESSAGE_BYTES=65536
$env:MAX_REQUEST_BODY_BYTES=131072
$env:PPROF_TOKEN='local-benchmark-token'
$env:RATE_LIMIT_MULTIPLIER=100
go build -o .\anonchat.exe ./cmd/server
.\anonchat.exe
```

```powershell
# Normal realistic traffic
go run ./cmd/loadtest -mode realistic -rooms 10 -participants 50 -messages-per-room-per-second 1 -message-bytes 500 -duration 5m -server-pid <PID>

# Source-sharing scenario
go run ./cmd/loadtest -mode realistic -rooms 10 -participants 50 -messages-per-room-per-second 1 -message-bytes 500 -source-message-bytes 32768 -source-message-every 60 -duration 5m -server-pid <PID>

# All-user sender stress
go run ./cmd/loadtest -mode realistic -rooms 10 -participants 50 -sender-mode all -messages-per-room-per-second 1 -message-bytes 500 -duration 1m -server-pid <PID>
```

Output uses stable `key=value` lines. Result measures one run, not capacity guarantee. Windows `-server-pid` uses `Get-Process`; unsupported systems print `server_resource_sampling=unsupported`.

## API

Read [docs/02-api-and-sse-contract.md](docs/02-api-and-sse-contract.md) for normative requests, responses, validation, status codes, and SSE events. Main routes: `GET /api/anon`, `GET|POST /api/room`, room join/message/poll/state, and `GET /api/room/:id/sse` with replay and snapshot fallback. Signaling intentionally returns `404 signal_disabled`.

Static GET/HEAD serves exact embedded assets. `/room/:id` receives exported room shell. API paths never fall back to HTML; missing hashed assets return `404`.
