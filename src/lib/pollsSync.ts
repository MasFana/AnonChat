import { connectToDatabase } from '@/lib/mongodb';
import { ObjectId } from 'mongodb';
import { roomEventBus } from './events';

interface PollOptionDoc { _id: ObjectId; text: string; votes: number }
interface PollDoc { _id: ObjectId; roomId: string | ObjectId; question: string; options: PollOptionDoc[]; active: boolean; createdAt: Date; updatedAt: Date }

const versions = new Map<string, number>();
const timers = new Map<string, NodeJS.Timeout>();
const DEBOUNCE_MS = 150; // batch rapid toggles/creates/deletes

export function getPollsVersion(roomId: string): number {
    return versions.get(roomId) ?? 0;
}

function bump(roomId: string): number {
    const v = (versions.get(roomId) ?? 0) + 1;
    versions.set(roomId, v);
    return v;
}

// Immediate full-list broadcast (increments version) used for create/delete where
// structural list changed and we want other clients to reflect instantly.
export async function immediatePollsReplace(roomId: string) {
    try {
        const db = await connectToDatabase();
        const pollsRaw = await db
            .collection('polls')
            .find({ $or: [{ roomId }, { roomId: new ObjectId(roomId) }] })
            .sort({ createdAt: -1 })
            .toArray();
        const polls = (pollsRaw as PollDoc[]).map((p) => ({
            ...p,
            _id: p._id.toString(),
            options: (p.options || []).map((o) => ({ ...o, _id: o._id.toString() })),
        }));
        const version = bump(roomId);
        roomEventBus.publish(roomId, { type: 'polls-replace', payload: { version, polls } });
    } catch { /* ignore */ }
}

export function schedulePollsReplace(roomId: string) {
    if (timers.has(roomId)) {
        clearTimeout(timers.get(roomId)!);
    }
    const t = setTimeout(async () => {
        try {
            const db = await connectToDatabase();
            const pollsRaw = await db
                .collection('polls')
                .find({ $or: [{ roomId }, { roomId: new ObjectId(roomId) }] })
                .sort({ createdAt: -1 })
                .toArray();
            const polls = (pollsRaw as PollDoc[]).map((p) => ({
                ...p,
                _id: p._id.toString(),
                options: (p.options || []).map((o) => ({ ...o, _id: o._id.toString() })),
            }));
            const version = bump(roomId);
            roomEventBus.publish(roomId, { type: 'polls-replace', payload: { version, polls } });
        } catch { /* ignore */ }
        finally {
            timers.delete(roomId);
        }
    }, DEBOUNCE_MS);
    timers.set(roomId, t);
}
