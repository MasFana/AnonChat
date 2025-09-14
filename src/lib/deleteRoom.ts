import { ObjectId } from 'mongodb';
import { connectToDatabase } from './mongodb';
import { roomEventBus } from './events';

/**
 * Deletes a room and all dependent documents atomically (best-effort).
 * Publishes a 'room-deleted' event for SSE subscribers to terminate.
 */
export async function deleteRoom(roomIdRaw: string | ObjectId) {
    const roomId = typeof roomIdRaw === 'string' ? new ObjectId(roomIdRaw) : roomIdRaw;
    const db = await connectToDatabase();

    const collections = ['rooms', 'users', 'messages', 'polls', 'votes', 'signals'];
    await Promise.allSettled(collections.map(async (name) => {
        const col = db.collection(name);
        if (name === 'rooms') {
            await col.deleteOne({ _id: roomId });
        } else {
            await col.deleteMany({ roomId });
        }
    }));

    // Broadcast deletion so SSE streams can close.
    roomEventBus.publish(roomId.toString(), { type: 'room-deleted', payload: { roomId: roomId.toString() } });
}
