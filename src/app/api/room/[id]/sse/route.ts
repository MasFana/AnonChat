import { NextRequest } from 'next/server';
import { connectToDatabase } from '@/lib/mongodb';
import { roomEventBus } from '@/lib/events';
import { getPollsVersion } from '@/lib/pollsSync';
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

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id: roomId } = await params;
    const url = new URL(req.url);
    const anonId = url.searchParams.get('anonId');
    if (!anonId) {
        return new Response('Missing anonId', { status: 400 });
    }

    const stream = new ReadableStream<Uint8Array>({
        start: async (controller) => {
            const encoder = new TextEncoder();

            const send = (e: { type: string; payload?: unknown }) => {
                controller.enqueue(encoder.encode(toSSE(e)));
            };

            // Subscribe to room events
            const unsubscribe = roomEventBus.subscribe(roomId, (evt) => send(evt));

            // Immediately send a snapshot of current state
            try {
                const db = await connectToDatabase();
                const room = await db.collection('rooms').findOne({ _id: new ObjectId(roomId) });
                if (!room) {
                    send({ type: 'room-deleted', payload: { roomId } });
                } else {
                    const recentCutoff = new Date(Date.now() - 20000); // 20s
                    const users = (await db.collection('users').find({ roomId, lastSeen: { $gte: recentCutoff } }).toArray()) as unknown as Array<{ id: string }>;
                    const messagesRaw = (await db
                        .collection('messages')
                        .find({ roomId })
                        .sort({ createdAt: 1 })
                        .toArray()) as Array<{ _id: ObjectId; roomId: string; userId: string; content: string; createdAt: Date }>;
                    const messages = messagesRaw.map((m) => ({
                        id: String(m._id),
                        roomId: m.roomId,
                        userId: m.userId,
                        content: m.content,
                        createdAt: m.createdAt,
                    }));
                    const pollsRaw = (await db
                        .collection('polls')
                        .find({ $or: [{ roomId }, { roomId: new ObjectId(roomId) }] })
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
                    send({ type: 'snapshot', payload: { users, messages, owner: ownerId, polls, myVotes, pollsVersion } });
                }
            } catch {
                // ignore snapshot errors
            }

            // Heartbeat to keep connection alive
            const heartbeat = setInterval(() => {
                send({ type: 'ping' });
            }, 15000);

            // Presence updates and cleanup
            // Global map for owner-leave cleanup timers so multiple connections do not schedule duplicates
            const gg = globalThis as unknown as { __ownerCleanupTimers?: Map<string, NodeJS.Timeout> };
            const timers = (gg.__ownerCleanupTimers = gg.__ownerCleanupTimers || new Map<string, NodeJS.Timeout>());
            const GRACE_MS = Number.isFinite(Number(process.env.OWNER_AWAY_GRACE_MS)) ? Number(process.env.OWNER_AWAY_GRACE_MS) : 5000;
            // (Removed periodic poll broadcast; now full-list events emitted on each mutation.)
            const presence = setInterval(async () => {
                try {
                    const db = await connectToDatabase();
                    // Update this user's lastSeen
                    await db
                        .collection('users')
                        .updateOne({ id: anonId, roomId }, { $set: { lastSeen: new Date() } });

                    // Remove inactive users (>10s)
                    const tenSecondsAgo = new Date(Date.now() - 10000);
                    const delRes = await db
                        .collection('users')
                        .deleteMany({ roomId, lastSeen: { $lt: tenSecondsAgo } });

                    // Fetch fresh users and check room health
                    const recentCutoff = new Date(Date.now() - 20000);
                    const users = (await db.collection('users').find({ roomId, lastSeen: { $gte: recentCutoff } }).toArray()) as unknown as Array<{ id: string }>;
                    const room = (await db.collection('rooms').findOne({ _id: new ObjectId(roomId) })) as { ownerId?: string } | null;
                    const hasOwner = room ? users.some((u) => u.id === room.ownerId) : false;
                    // Delete immediately only if room missing or no users remain
                    if (!room || users.length === 0) {
                        // Cancel any pending owner-leave timer
                        const existingTimer = timers.get(roomId);
                        if (existingTimer) { clearTimeout(existingTimer); timers.delete(roomId); }
                        // Cleanup room and notify
                        await db.collection('rooms').deleteOne({ _id: new ObjectId(roomId) });
                        await db.collection('messages').deleteMany({ roomId });
                        await db.collection('users').deleteMany({ roomId });
                        await db.collection('polls').deleteMany({ roomId });
                        await db.collection('votes').deleteMany({ roomId });
                        roomEventBus.publish(roomId, { type: 'room-deleted', payload: { roomId } });
                        return;
                    }

                    // If owner is absent, either delete immediately or schedule a short grace-period cleanup
                    if (!hasOwner) {
                        if (GRACE_MS <= 0) {
                            // Immediate delete when owner away is requested
                            const existingTimer = timers.get(roomId);
                            if (existingTimer) { clearTimeout(existingTimer); timers.delete(roomId); }
                            await db.collection('rooms').deleteOne({ _id: new ObjectId(roomId) });
                            await db.collection('messages').deleteMany({ roomId });
                            await db.collection('users').deleteMany({ roomId });
                            await db.collection('polls').deleteMany({ roomId });
                            await db.collection('votes').deleteMany({ roomId });
                            roomEventBus.publish(roomId, { type: 'room-deleted', payload: { roomId } });
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
                                        await db2.collection('rooms').deleteOne({ _id: new ObjectId(roomId) });
                                        await db2.collection('messages').deleteMany({ roomId });
                                        await db2.collection('users').deleteMany({ roomId });
                                        await db2.collection('polls').deleteMany({ roomId });
                                        await db2.collection('votes').deleteMany({ roomId });
                                        roomEventBus.publish(roomId, { type: 'room-deleted', payload: { roomId } });
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
            }, 5000);

            // Cleanup on close
            const cancel = () => {
                clearInterval(heartbeat);
                clearInterval(presence);
                unsubscribe();
                // Best-effort immediate cleanup when a client (possibly last user / owner) disconnects.
                (async () => {
                    try {
                        const db = await connectToDatabase();
                        // Remove this user record immediately (so last user leaving triggers emptiness)
                        await db.collection('users').deleteOne({ id: anonId, roomId });
                        // Prune any clearly stale users too (safety)
                        const tenSecondsAgo = new Date(Date.now() - 10000);
                        await db.collection('users').deleteMany({ roomId, lastSeen: { $lt: tenSecondsAgo } });
                        // Re-check remaining users & room
                        const users = await db.collection('users').find({ roomId }).toArray();
                        const room = await db.collection('rooms').findOne({ _id: new ObjectId(roomId) });
                        if (!room || users.length === 0) {
                            // Delete entire room cascade if now empty
                            await db.collection('rooms').deleteOne({ _id: new ObjectId(roomId) });
                            await db.collection('messages').deleteMany({ roomId });
                            await db.collection('polls').deleteMany({ roomId });
                            await db.collection('votes').deleteMany({ roomId });
                            await db.collection('users').deleteMany({ roomId }); // idempotent cleanup
                            roomEventBus.publish(roomId, { type: 'room-deleted', payload: { roomId } });
                        } else {
                            // Otherwise broadcast updated users list (dedup best-effort)
                            roomEventBus.publish(roomId, { type: 'users', payload: users });
                        }
                    } catch {
                        // ignore disconnect cleanup errors
                    }
                })();
                try { controller.close(); } catch { }
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
