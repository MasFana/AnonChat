# 04 Migration and Implementation Plan

## Removed and changed
**REMOVED BY IN-MEMORY ARCHITECTURE:** all persistence configuration, runtime storage helpers, collection models, indexes, TTL, transactions, change streams, migrations, data cleanup, presence writes, and data recovery. Existing historical data is not migrated. Cutover starts empty; old rooms disappear at cutover/restart.

**INTENTIONAL CHANGE:** bounded messages, one active poll/no history, uniform owner grace, actor overload/capacity rejection, SSE replay/snapshot, and frontend authoritative SSE replace periodic poll reconciliation.

## Ordered work
1. **Frontend static export.** Remove API route handlers; make `/` and room shell client/static-safe; remove runtime-only font/metadata paths; configure export to `web/dist`. Keep same-origin `/api/*`, localStorage `anonId`, text rendering, and `/room/:id` navigation.
2. **Go skeleton.** Create module, `cmd/server`, config with validated limits, `slog`, root context, ID generator, typed public errors, static handler.
3. **Registry.** Add capacity, `RoomRef` leases, draining, public summaries, create/list handlers. No repository abstraction.
4. **Room actor.** Implement command/result protocol, fixed rings, users, join/meta/state/message, sequence emission, fake-clock timer abstraction.
5. **Lifecycle.** Implement subscription counts, owner grace, empty-room deletion, registry close protocol, shutdown race behavior.
6. **Messages.** Enforce body/content bounds and 100-message server/client retention. UI does not optimistic-add messages.
7. **Owner capability.** Generate capability at creation; return it once; retain only in actor state; require it for visibility and poll mutations; store it in room-keyed `sessionStorage`; never expose or log it.
8. **Polls.** Change UI to one nullable active poll. Implement owner create/close/delete and atomic vote replacement. Remove poll list, reopen, `polls-replace`, and 60-second reconciliation.
9. **SSE.** Implement headers, flushing writer, bounded queues, snapshot/replay atomic subscription command, IDs, heartbeat, client sequence dedupe/reconnect, terminal deletion.
10. **Signals.** Keep both routes disabled with `404 signal_disabled`; remove signal state and persistence-era migration work. Re-add only with shipped WebRTC frontend feature.
11. **Static serving.** Embed `web/dist`; test asset/cache and `/room/:id` fallback; never fallback API or missing hashed assets.
12. **Observability.** Add health/readiness, metrics endpoint using stdlib-compatible exposition, protected pprof, structured logs without message bodies or credentials.
13. **Tests.** Add tests in `05`; pass unit, integration, race, browser smoke, benchmark/load gates.
14. **Cutover.** Deploy exactly one process. Drain old service; switch traffic; disclose empty-state reset. No data import and no parallel shared-room operation.

## Compatibility notes
Preserve `/api/anon`, room create/list/join/message/meta/visibility, active-poll routes, state, SSE path/query, and same-origin SPA use where possible. Existing frontend must change for new poll payload/vocabulary and SSE IDs/replay; these are deliberate contract changes. Static React build is build-time Node only; production Go binary has no Node runtime.
