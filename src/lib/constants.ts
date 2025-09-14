// Unified timing / presence constants
// Adjust via environment variables if needed; fallback to sane defaults.

export const RECENT_USER_WINDOW_MS = parseInt(process.env.RECENT_USER_WINDOW_MS || '', 10) || 15000; // window to consider a user "active"
export const STALE_USER_PRUNE_MS = parseInt(process.env.STALE_USER_PRUNE_MS || '', 10) || 15000; // lastSeen older than this gets pruned
export const PRESENCE_INTERVAL_MS = parseInt(process.env.PRESENCE_INTERVAL_MS || '', 10) || 5000; // how often presence loop runs
export const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS || '', 10) || 15000; // SSE ping
export const OWNER_AWAY_GRACE_MS = Number.isFinite(Number(process.env.OWNER_AWAY_GRACE_MS)) ? Number(process.env.OWNER_AWAY_GRACE_MS) : 5000;
export const LAST_SEEN_WRITE_THROTTLE_MS = parseInt(process.env.LAST_SEEN_WRITE_THROTTLE_MS || '', 10) || 4000; // minimum gap between lastSeen writes per user

export const MAX_SNAPSHOT_MESSAGES = parseInt(process.env.MAX_SNAPSHOT_MESSAGES || '', 10) || 5000; // cap snapshot size (future use)

export function recentCutoffDate(now = Date.now()) { return new Date(now - RECENT_USER_WINDOW_MS); }
export function staleCutoffDate(now = Date.now()) { return new Date(now - STALE_USER_PRUNE_MS); }

