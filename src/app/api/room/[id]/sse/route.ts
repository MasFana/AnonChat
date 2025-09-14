import { NextRequest } from 'next/server';
import { connectToDatabase } from '@/lib/mongodb';
import { roomEventBus } from '@/lib/events';
import { getPollsVersion } from '@/lib/pollsSync';
import { OWNER_AWAY_GRACE_MS, RECENT_USER_WINDOW_MS, STALE_USER_PRUNE_MS, PRESENCE_INTERVAL_MS, HEARTBEAT_INTERVAL_MS, LAST_SEEN_WRITE_THROTTLE_MS, MAX_SNAPSHOT_MESSAGES } from '@/lib/constants';
import { deleteRoom } from '@/lib/deleteRoom';
import { ObjectId } from 'mongodb';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type PollOptionDoc = { _id: ObjectId; text: string; votes: number };
// roomId might be persisted as string or ObjectId
type PollDoc = { _id: ObjectId; roomId: string | ObjectId; question: string; options: PollOptionDoc[]; active: boolean; createdAt: Date; updatedAt: Date };

function toSSE(event: { type: string; payload?: unknown }) {
    const data = JSON.stringify({ type: event.type, payload: event.payload });
    return `event: ${event.type}\ndata: ${data}\n\n`;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const { id: roomId } = await ctx.params; // await per Next.js dynamic route guidance
    const url = new URL(req.url);
    const anonId = url.searchParams.get('anonId');
    if (!anonId) {
        return new Response('Missing anonId', { status: 400 });
    }

    // Fast path: if room does not exist, respond 410 Gone (client should not retry)
    try {
        const dbEarly = await connectToDatabase();
        const exists = await dbEarly.collection('rooms').findOne({ _id: new ObjectId(roomId) });
        if (!exists) {
            return new Response('Room closed', {
                status: 410,
                headers: {
                    'Cache-Control': 'no-cache',
                    'Content-Type': 'text/plain'
                }
            });
        }
    } catch {
        // On DB error we continue to attempt stream (could fallback to 503)
    }

    const stream = new ReadableStream<Uint8Array>({
        start: async (controller) => {
            const encoder = new TextEncoder();
            let closed = false;

            const send = (e: { type: string; payload?: unknown }) => {
                if (closed) return; // stream already closed
                try {
                    controller.enqueue(encoder.encode(toSSE(e)));
                } catch {
                    // controller already closed or errored; mark closed to stop future sends
                    closed = true;
                }
            };

            // Subscribe to room events
            const unsubscribe = roomEventBus.subscribe(roomId, (evt) => send(evt));

            // Immediately send a snapshot of current state
            try {
                const db = await connectToDatabase();
                const room = await db.collection('rooms').findOne({ _id: new ObjectId(roomId) });
                if (!room) {
                    // In rare race, room deleted after early existence check: emit room-deleted with retry suppression then close.
                    try {
                        controller.enqueue(new TextEncoder().encode('retry: 0\n'));
                    } catch { }
                    send({ type: 'room-deleted', payload: { roomId } });
                    try { controller.close(); } catch { }
                } else {
                    const recentCutoff = new Date(Date.now() - RECENT_USER_WINDOW_MS);
                    const users = (await db.collection('users').find({ roomId, lastSeen: { $gte: recentCutoff } }).toArray()) as unknown as Array<{ id: string }>;
                    const messagesRawFull = (await db
                        .collection('messages')
                        .find({ roomId })
                        .sort({ createdAt: -1 })
                        .limit(MAX_SNAPSHOT_MESSAGES)
                        .toArray()) as Array<{ _id: ObjectId; roomId: string; userId: string; content: string; createdAt: Date }>;
                    const messagesRaw = messagesRawFull.reverse(); // restore chronological order
                    const messages = messagesRaw.map((m) => ({
                        id: String(m._id),
                        roomId: m.roomId,
                        userId: m.userId,
                        content: m.content,
                        createdAt: m.createdAt,
                    }));
                    const pollsRaw = (await db
                        .collection('polls')
                        .find({ roomId: new ObjectId(roomId) })
                        .sort({ createdAt: -1 })
                        .toArray()) as PollDoc[];
                    const polls = pollsRaw.map((p) => ({
                        ...p,
                        _id: String(p._id),
                        options: (p.options || []).map((o) => ({ ...o, _id: String(o._id) })),
                    }));
                    // Votes by this anonId for this room (if any)
                    const myVotesRaw = (await db.collection('votes').find({ roomId, anonId }).toArray()) as unknown as Array<{ pollId: string; optionId: string }>;
                    const myVotes = myVotesRaw.reduce<Record<string, string>>((acc, v) => {
                        acc[v.pollId] = v.optionId; return acc;
                    }, {});
                    const pollsVersion = getPollsVersion(roomId);
                    const ownerId = (room as { ownerId?: string } | null)?.ownerId;
                    const isPublic = (room as { isPublic?: boolean } | null)?.isPublic ?? false;
                    send({ type: 'snapshot', payload: { users, messages, owner: ownerId, polls, myVotes, pollsVersion, isPublic } });
                }
            } catch {
                // ignore snapshot errors
            }

            // Heartbeat to keep connection alive
            const heartbeat = setInterval(() => {
                send({ type: 'ping' });
            }, HEARTBEAT_INTERVAL_MS);

            // Presence updates and cleanup
            // Global map for owner-leave cleanup timers so multiple connections do not schedule duplicates
            const gg = globalThis as unknown as { __ownerCleanupTimers?: Map<string, NodeJS.Timeout> };
            const timers = (gg.__ownerCleanupTimers = gg.__ownerCleanupTimers || new Map<string, NodeJS.Timeout>());
            const GRACE_MS = OWNER_AWAY_GRACE_MS;
            // (Removed periodic poll broadcast; now full-list events emitted on each mutation.)
            // Track last write time per anonId (in-memory per server instance)
            const gThrottle = globalThis as unknown as { __lastSeenWrites?: Map<string, number> };
            const lastSeenMap = gThrottle.__lastSeenWrites = gThrottle.__lastSeenWrites || new Map<string, number>();
            const presence = setInterval(async () => {
                try {
                    const db = await connectToDatabase();
                    // Throttled lastSeen update
                    const key = `${roomId}:${anonId}`;
                    const now = Date.now();
                    const last = lastSeenMap.get(key) || 0;
                    if (now - last >= LAST_SEEN_WRITE_THROTTLE_MS) {
                        await db.collection('users').updateOne({ id: anonId, roomId }, { $set: { lastSeen: new Date() } });
                        lastSeenMap.set(key, now);
                    }

                    // Remove inactive users older than STALE_USER_PRUNE_MS
                    const staleCutoff = new Date(Date.now() - STALE_USER_PRUNE_MS);
                    const delRes = await db.collection('users').deleteMany({ roomId, lastSeen: { $lt: staleCutoff } });

                    // Fetch fresh users and check room health
                    const recentCutoff = new Date(Date.now() - RECENT_USER_WINDOW_MS);
                    const users = (await db.collection('users').find({ roomId, lastSeen: { $gte: recentCutoff } }).toArray()) as unknown as Array<{ id: string }>;
                    const room = (await db.collection('rooms').findOne({ _id: new ObjectId(roomId) })) as { ownerId?: string } | null;
                    const hasOwner = room ? users.some((u) => u.id === room.ownerId) : false;
                    // Delete immediately only if room missing or no users remain
                    if (!room || users.length === 0) {
                        const existingTimer = timers.get(roomId);
                        if (existingTimer) { clearTimeout(existingTimer); timers.delete(roomId); }
                        await deleteRoom(roomId);
                        shutdown();
                        return;
                    }

                    // If owner is absent, either delete immediately or schedule a short grace-period cleanup
                    if (!hasOwner) {
                        if (GRACE_MS <= 0) {
                            const existingTimer = timers.get(roomId);
                            if (existingTimer) { clearTimeout(existingTimer); timers.delete(roomId); }
                            await deleteRoom(roomId);
                            shutdown();
                            return;
                        }
                        if (!timers.has(roomId)) {
                            const t = setTimeout(async () => {
                                try {
                                    const db2 = await connectToDatabase();
                                    const users2 = (await db2.collection('users').find({ roomId }).toArray()) as unknown as Array<{ id: string }>;
                                    const room2 = (await db2.collection('rooms').findOne({ _id: new ObjectId(roomId) })) as { ownerId?: string } | null;
                                    const hasOwner2 = room2 ? users2.some((u) => u.id === room2.ownerId) : false;
                                    if (!room2 || users2.length === 0 || !hasOwner2) {
                                        await deleteRoom(roomId);
                                    }
                                } finally {
                                    timers.delete(roomId);
                                }
                            }, GRACE_MS);
                            timers.set(roomId, t);
                        }
                    } else {
                        // Owner present: cancel any scheduled cleanup
                        const existingTimer = timers.get(roomId);
                        if (existingTimer) { clearTimeout(existingTimer); timers.delete(roomId); }
                    }

                    // If users changed (best-effort): publish users on deletion or every cycle
                    if (delRes.deletedCount && delRes.deletedCount > 0) {
                        roomEventBus.publish(roomId, { type: 'users', payload: users });
                    }
                } catch {
                    // ignore
                }
            }, PRESENCE_INTERVAL_MS);

            // Cleanup on close
            const shutdown = () => {
                if (closed) return; // idempotent
                closed = true;
                clearInterval(heartbeat);
                clearInterval(presence);
                unsubscribe();
                try { controller.close(); } catch { }
            };

            const cancel = () => {
                // Remove this user then decide if room deletion required
                (async () => {
                    try {
                        const db = await connectToDatabase();
                        await db.collection('users').deleteOne({ id: anonId, roomId });
                        const staleCutoff = new Date(Date.now() - STALE_USER_PRUNE_MS);
                        await db.collection('users').deleteMany({ roomId, lastSeen: { $lt: staleCutoff } });
                        const usersLeft = await db.collection('users').find({ roomId }).toArray();
                        const room = await db.collection('rooms').findOne({ _id: new ObjectId(roomId) });
                        if (!room) { shutdown(); return; }
                        if (usersLeft.length === 0) {
                            await deleteRoom(roomId);
                        } else {
                            roomEventBus.publish(roomId, { type: 'users', payload: usersLeft });
                        }
                    } catch {
                        // ignore
                    } finally {
                        shutdown();
                    }
                })();
            };

            // If client disconnects
            req.signal.addEventListener('abort', cancel);
        },
        cancel() {
            // stream canceled
        },
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        },
    });
}
