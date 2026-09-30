# UI baseline — before static conversion

Captured from committed pre-conversion screenshots on 2026-09-29. Source review supplements states not represented by screenshots. Live run blocked: dependencies absent; `npm ci` exceeds tool time limit and runs separately.

| State | Evidence / exact behavior |
|---|---|
| Homepage, rooms | `homepage-before.png`. Dark page, hero, create/join cards, statistics, room grid, footer. Source polls rooms every 10 seconds. Empty state text: `No rooms yet. Be the first to create one above.` |
| Create room | Source POSTs `/api/room` with localStorage `anonId`, then routes to `/room/<roomId>`. |
| Room Closed | Homepage reads `msg` query using `useSearchParams`; deletion routes to `/?msg=Room%20Closed`. |
| Owner room | `room-owner-before.png`. Messages, composer, users, visibility toggle, poll creation and owner controls. |
| Participant room | `room-participant-before.png`. Messages, users/presence, poll voting; owner controls absent. |
| Live/deletion | Existing SSE handles message/users/poll events. On `room-deleted`, stream closes and routes to `/?msg=Room%20Closed`. |
| Desktop/mobile/theme | Screenshots record desktop dark theme only. Layout root forces `className="dark"`; no light-theme toggle found. Mobile needs live browser re-check after dependencies/API are available. |

## Limits

No running backend or browser automation available at capture. Owner/participant interaction, deletion, fresh deep link, mobile width require re-verification against mock/Go API after contract files and dependencies are available.