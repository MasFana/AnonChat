import { ObjectId } from 'mongodb';
import { connectToDatabase } from './mongodb';
import { roomEventBus } from './events';

/**
 * Deletes a room and all dependent documents atomically (best-effort).
 * Publishes a 'room-deleted' event for SSE subscribers to terminate.
 */
export async function deleteRoom(roomIdRaw: string | ObjectId) {
    const roomIdObj = typeof roomIdRaw === 'string' ? new ObjectId(roomIdRaw) : roomIdRaw;
    const roomIdStr = roomIdObj.toString();
    const db = await connectToDatabase();

    /**
     * Root cause of prior cascade bug:
     *  - Dependent collections (messages, users, votes, signals, legacy polls) stored roomId as string.
     *  - Refactored queries started using ObjectId for room documents.
     *  - deleteRoom previously did deleteMany({ roomId: ObjectId }), which matched nothing for string-stored docs.
     * Fix: delete using $in / $or to match both representations during transition period.
     * After full data migration you can simplify to a single representation.
     */
    const collections = ['rooms', 'users', 'messages', 'polls', 'votes', 'signals'];
    await Promise.allSettled(collections.map(async (name) => {
        const col = db.collection(name);
        if (name === 'rooms') {
            await col.deleteOne({ _id: roomIdObj });
        } else {
            // Match either string or ObjectId roomId (hybrid phase)
            await col.deleteMany({ $or: [ { roomId: roomIdObj }, { roomId: roomIdStr } ] });
        }
    }));

    // Broadcast deletion so SSE streams can close.
    roomEventBus.publish(roomIdStr, { type: 'room-deleted', payload: { roomId: roomIdStr } });
}
