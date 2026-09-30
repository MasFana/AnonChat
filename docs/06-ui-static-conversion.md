# 06 UI static conversion audit

Scope: source snapshot before frontend conversion. No app code changed by audit. Contract source: `docs/01-architecture.md` through `docs/05-limits-performance-and-test-plan.md`. Baseline source: `README.md`; visual evidence: `docs/migration/ui-baseline/`.

## Baseline capture and tooling

| Item                | Result       | Evidence / action                                                                                                                   |
| ------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Homepage            | captured     | `docs/migration/ui-baseline/homepage-before.png`                                                                                    |
| Owner room          | captured     | `docs/migration/ui-baseline/room-owner-before.png`                                                                                  |
| Participant room    | captured     | `docs/migration/ui-baseline/room-participant-before.png`                                                                            |
| Missing live states | not captured | room closed, create/join, owner/participant interaction, fresh deep link, mobile width. Baseline README records same gaps.          |
| Browser tooling     | blocked      | `Get-Command chromium, chrome, msedge, firefox, playwright` found none. `npx` exists. No installed `*playwright*` directory.        |
| Live app            | blocked      | baseline README says dependencies absent and `npm ci` exceeds tool time. Current audit does not install dependencies or change app. |

Capture missing states only against mock or Go API after browser tooling exists. Do not recapture listed PNG states without visual change.

## Full `src` table

| Path                                           | Current role                                       | Static-export status                                                            | Conversion action                                                                                 |
| ---------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `src/app/favicon.ico`                          | app icon                                           | static asset                                                                    | keep                                                                                              |
| `src/app/globals.css`                          | Tailwind v4 theme and global styles                | build-safe                                                                      | keep; remove font variables only if layout removes font loader                                    |
| `src/app/layout.tsx`                           | root HTML, dark class, metadata, Geist font loader | server/runtime font risk                                                        | make export-safe; replace `next/font` with CSS/system font or local static font; retain dark root |
| `src/app/page.tsx`                             | homepage server wrapper                            | static-safe if no dynamic data                                                  | retain as static wrapper or merge into client page                                                |
| `src/app/pageClient.tsx`                       | homepage UI, anon identity, room list/create/join  | client-safe; API-dependent                                                      | retain UI; use same-origin contract; persist returned owner capability on create                  |
| `src/app/robots.ts`                            | generated robots route                             | export compatibility decision required                                          | emit static `public/robots.txt` or prove exported route output                                    |
| `src/app/sitemap.ts`                           | generated sitemap with `NEXT_PUBLIC_SITE_URL`      | export/runtime env decision required                                            | emit static `public/sitemap.xml` or retain only build-time-safe output                            |
| `src/app/room/[id]/page.tsx`                   | dynamic room wrapper                               | incompatible with static route generation unless client shell/fallback strategy | produce export-safe room shell; Go serves SPA shell for `/room/:id`                               |
| `src/app/room/[id]/roomClient.tsx`             | room UI, HTTP, EventSource, polls                  | client-safe; old contract incompatible                                          | retain UI shape; replace poll/SSE/capability behavior per contract                                |
| `src/app/api/anon/route.ts`                    | Next anon-ID generator                             | server-only                                                                     | remove after Go owns `GET /api/anon`                                                              |
| `src/app/api/room/route.ts`                    | Mongo room create/list                             | server-only                                                                     | remove after Go owns `POST`/`GET /api/room`                                                       |
| `src/app/api/room/[id]/join/route.ts`          | Mongo join/presence                                | server-only                                                                     | remove after Go owns join                                                                         |
| `src/app/api/room/[id]/message/route.ts`       | Mongo message write                                | server-only                                                                     | remove after Go owns message                                                                      |
| `src/app/api/room/[id]/meta/route.ts`          | Mongo room metadata                                | server-only                                                                     | remove after Go owns meta                                                                         |
| `src/app/api/room/[id]/poll/route.ts`          | Mongo create/list polls                            | server-only                                                                     | remove after Go owns active-poll routes                                                           |
| `src/app/api/room/[id]/poll/[pollId]/route.ts` | Mongo vote/close/delete poll                       | server-only                                                                     | remove; client changes from poll ID routes                                                        |
| `src/app/api/room/[id]/signal/route.ts`        | Mongo WebRTC signaling                             | server-only, no UI consumer                                                     | remove; Go returns `404 signal_disabled` for both methods                                         |
| `src/app/api/room/[id]/sse/route.ts`           | Node stream, event bus, DB snapshot                | server-only                                                                     | remove after Go owns SSE                                                                          |
| `src/app/api/room/[id]/state/route.ts`         | Mongo state snapshot                               | server-only                                                                     | remove after Go owns state                                                                        |
| `src/app/api/room/[id]/visibility/route.ts`    | Mongo owner visibility mutation                    | server-only                                                                     | remove after Go owns visibility with capability                                                   |
| `src/components/ui/button.tsx`                 | shadcn button                                      | build-safe                                                                      | keep                                                                                              |
| `src/components/ui/card.tsx`                   | shadcn card                                        | build-safe                                                                      | keep                                                                                              |
| `src/components/ui/input.tsx`                  | shadcn input                                       | build-safe                                                                      | keep                                                                                              |
| `src/lib/constants.ts`                         | legacy Next timing constants                       | server-only legacy support                                                      | remove with API layer if no frontend import                                                       |
| `src/lib/deleteRoom.ts`                        | Mongo deletion and event publish                   | server-only                                                                     | remove with API layer                                                                             |
| `src/lib/events.ts`                            | process-global Node event bus                      | server-only                                                                     | remove with API layer                                                                             |
| `src/lib/mongodb.ts`                           | Mongo connection                                   | server-only                                                                     | remove with API layer                                                                             |
| `src/lib/pollsSync.ts`                         | Mongo poll reconciliation and `polls-replace`      | server-only, rejected design                                                    | remove with API layer                                                                             |
| `src/lib/utils.ts`                             | `cn` helper                                        | build-safe                                                                      | keep                                                                                              |

`src/app/api/**` contains 12 route files and 18 handlers. Static export cannot include these runtime route handlers. `src/lib/{mongodb,events,deleteRoom,pollsSync,constants}.ts` exists for old Next/Mongo backend; frontend must not import them.

## API inventory

| Method/path                         | Current frontend use                       | Current handler             | Target decision                                                                                            |
| ----------------------------------- | ------------------------------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `GET /api/anon`                     | homepage and room identity bootstrap       | random `anon-` ID           | keep; Go owns                                                                                              |
| `GET /api/room`                     | homepage initial load, then 10-second poll | Mongo public list/stats     | keep; Go owns; client interval decision below                                                              |
| `POST /api/room`                    | create room with `{anonId}`                | Mongo create, owner ID only | keep; response must include `ownerCapability`; client writes room-keyed `sessionStorage` before navigation |
| `POST /api/room/:id/join`           | homepage join and room mount               | Mongo presence write        | keep; Go owns                                                                                              |
| `POST /api/room/:id/message`        | composer                                   | Mongo message write         | keep; Go owns                                                                                              |
| `GET /api/room/:id/meta`            | room mount, owner and visibility UI        | Mongo metadata              | keep; Go owns; must not expose capability                                                                  |
| `GET /api/room/:id/state`           | no inspected frontend call                 | Mongo snapshot              | keep in target contract; reserve for resync/debug unless client needs it                                   |
| `PATCH /api/room/:id/visibility`    | owner toggle `{anonId,isPublic}`           | owner ID check              | keep; add `ownerCapability`                                                                                |
| `GET /api/room/:id/poll`            | 60-second reconciliation                   | historical poll list        | replace with nullable active-poll payload or remove client call                                            |
| `POST /api/room/:id/poll`           | create `{anonId,question,options}`         | historical poll create      | keep semantics; add `ownerCapability`; one active poll                                                     |
| `POST /api/room/:id/poll/:pollId`   | vote `{anonId,optionId}`                   | vote legacy poll            | replace with target active-poll vote route/payload from contract                                           |
| `PATCH /api/room/:id/poll/:pollId`  | close/reopen `{active,anonId}`             | owner update                | replace; close only, add capability; reopening unsupported                                                 |
| `DELETE /api/room/:id/poll/:pollId` | owner delete                               | owner delete                | replace; add capability                                                                                    |
| `GET /api/room/:id/sse?anonId=`     | `EventSource` room stream                  | Node SSE                    | keep path/query; Go owns; add replay cursor behavior                                                       |
| `GET /api/room/:id/signal?for=`     | no inspected frontend call                 | Mongo signal dequeue        | disable: `404 signal_disabled`                                                                             |
| `POST /api/room/:id/signal`         | no inspected frontend call                 | Mongo signal enqueue        | disable: `404 signal_disabled`                                                                             |

## EventSource inventory

Single constructor: `src/app/room/[id]/roomClient.tsx` opens `new EventSource(`/api/room/${roomId}/sse?anonId=${id}`)` after metadata and join.

| Event             | Current client behavior                                   | Target decision                                                                                            |
| ----------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `snapshot`        | replaces users, messages, owner, votes, polls, visibility | keep initial snapshot; adapt from `polls` list to nullable `poll`; consume event `id`/sequence             |
| `room-visibility` | updates visibility and clears busy state                  | keep if contract emits it; sequence-dedupe                                                                 |
| `users`           | replaces users                                            | keep; sequence-dedupe                                                                                      |
| `message`         | appends message; browser notification                     | keep; retain 100 client messages; sequence-dedupe                                                          |
| `poll-created`    | upserts historical poll                                   | replace with active-poll event vocabulary                                                                  |
| `poll-updated`    | changes active flag                                       | replace with target active-poll event vocabulary; no reopen                                                |
| `polls-replace`   | replaces list, version gates payload                      | remove; contract rejects it                                                                                |
| `poll-deleted`    | removes one poll                                          | adapt for nullable active poll                                                                             |
| `vote-cast`       | updates poll and own vote                                 | keep equivalent target event; sequence-dedupe                                                              |
| `room-deleted`    | closes stream, routes `/?msg=Room+Closed`                 | keep terminal behavior; no reconnect                                                                       |
| `error`           | native EventSource reconnect only                         | add explicit sequence tracking, replay query/cursor, gap snapshot handling; preserve terminal no-reconnect |

Current client opens no `WebSocket`. Current client never calls signal routes.

## Conflicts and questions

| Finding                                                                                                                             | Impact                                                             | Required resolution                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| README advertises MongoDB, Next API, persistence, WebRTC signaling. Docs 01-05 require in-memory Go, no database, disabled signals. | README describes retired architecture.                             | Rewrite README after Go/static cutover.                                                                 |
| `next.config.ts` has no `output: 'export'` or `distDir: 'web/dist'`.                                                                | current build remains server deployment.                           | frontend sets export output and build target.                                                           |
| Next API routes plus Mongo imports exist under `src`.                                                                               | static export fails or leaves wrong backend.                       | delete routes and old server libs in frontend conversion; Go owns `/api/*`.                             |
| Current creation returns no `ownerCapability`; client uses only `anonId`.                                                           | target owner authorization cannot work.                            | store creation capability in `sessionStorage` keyed by room ID; send it for visibility/poll mutations.  |
| Current poll UI supports history, reopening, `polls-replace`, 60-second `GET /poll`.                                                | conflicts with one nullable active poll.                           | remove list/reopen/reconciliation and adopt target payload/events.                                      |
| Current SSE has no client sequence dedupe/replay cursor.                                                                            | conflicts with target replay contract.                             | track highest SSE ID, dedupe, reconnect with cursor, accept snapshot gap fallback.                      |
| Current room page is `[id]` dynamic route.                                                                                          | static exporter has no finite room IDs.                            | export shell strategy required; Go must return SPA shell for `/room/:id`.                               |
| `layout.tsx`, `robots.ts`, `sitemap.ts` need direct export check.                                                                   | Next static build may reject runtime-only paths.                   | inspect/build after frontend diff; replace generated files with static assets if rejected.              |
| Current fallback anon generation uses `Math.random()`.                                                                              | weak identity fallback and target Go source differs.               | choose: retain only as offline UI fallback, or remove and surface API failure. Default remove fallback. |
| Homepage room refresh every 10 seconds.                                                                                             | docs exclude global room-list SSE but permit HTTP cache 2 seconds. | keep polling, 10 seconds acceptable; stop timer on unmount.                                             |

## Export, serving, and dev workflow decisions

1. Frontend build uses static export into `web/dist`. Node exists only for build. Production binary runs no Node, Next, or MongoDB.
2. Browser uses relative same-origin `/api/*` URLs. No client API base URL, proxy, or new dependency.
3. Go embeds `web/dist` with `go:embed`. Exact assets serve files. Hashed assets use long immutable cache. Missing hashed assets return `404`.
4. Go routes `/api/*` only to API handlers. Never SPA-fallback API paths. `GET`/`HEAD` non-API unknown paths, including `/room/:id`, return SPA shell. Do not fallback missing assets.
5. Development needs two processes: static frontend watcher/server plus Go API/static server, or frontend dev server proxying `/api` to Go. Production test must use Go static handler, not `next dev` or `next start`.
6. `next dev --turbopack` and `next start` are legacy Next-server scripts after cutover. Replace documented frontend commands with export build and static/Go integration workflow only after scripts change.
7. Browser smoke gate: `/`, create, `/room/:id` direct load, SSE update/reconnect, room deletion, missing hashed asset `404`, API path no SPA fallback. Recheck mobile before release.

## Final audit

- **Message retention:** `MAX_CLIENT_MESSAGES = 1000`, matching the user's final decision and superseding the earlier task suggestion of 100.
- **Build:** `pnpm build` passes with static export to `web/dist`; output is 38 files totaling 1,103,109 bytes (approximately 1.10 MB). Routes include `/`, `/room/placeholder`, `/robots.txt`, and `/sitemap.xml`.
- **URL/file map:** `/` serves `web/dist/index.html`; `/room/:id` serves the exported room shell; `/api/*` is reserved for the Go/mock API; hashed `/_next/static/*` assets remain exact-file requests.
- **Development checks:** TypeScript, ESLint, static export, mock API contract smoke, and arbitrary-room fallback checks pass. The mock check runs at `http://127.0.0.1:3001`.
- **Error mapping:** client notices cover `invalid_anon_id`, `room_not_found`, `room_closed`, `forbidden`, `poll_active`, `poll_closed`, `invalid_poll`, `invalid_vote`, and `rate_limited`; endpoint errors retain typed HTTP status/code fields.
- **Remaining risks:** the Go runtime, browser reconnect UX, and mobile layout still need an integration/browser gate once the Go server exists. Owner capability remains unrecoverable if session storage is cleared, by design.
- **Confidence:** high for static build, active frontend contract wiring, and the Node mock contract; medium for production behavior until Go integration and browser smoke are available.
