import { NextRequest, NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/mongodb';
import { ObjectId } from 'mongodb';
import { roomEventBus } from '@/lib/events';

// GET /api/room/[id]/state
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
    const db = await connectToDatabase();
    const url = new URL(req.url);
    const anonId = url.searchParams.get('anonId');
    if (!anonId) return NextResponse.json({ error: 'Missing anonId' }, { status: 400 });

    const { id } = params;

    // Update lastSeen for current user
    await db.collection('users').updateOne(
        { id: anonId, roomId: id },
        { $set: { lastSeen: new Date() } }
    );

    // Remove inactive users (lastSeen > 10s ago)
    const tenSecondsAgo = new Date(Date.now() - 10000);
    await db.collection('users').deleteMany({ roomId: id, lastSeen: { $lt: tenSecondsAgo } });

    // Get current users and room
    const users = await db.collection('users').find({ roomId: id }).toArray();
    const room = await db.collection('rooms').findOne({ _id: new ObjectId(id) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!room || users.length === 0 || !users.find((u: any) => u.id === room.ownerId)) {
        // Cleanup: delete room, messages, users
        await db.collection('rooms').deleteOne({ _id: new ObjectId(id) });
        await db.collection('messages').deleteMany({ roomId: id });
        await db.collection('users').deleteMany({ roomId: id });
        await db.collection('polls').deleteMany({ roomId: id });
        await db.collection('votes').deleteMany({ roomId: id });
        roomEventBus.publish(id, { type: 'room-deleted', payload: { roomId: id } });
        return NextResponse.json({ deleted: true });
    }
    const messages = await db.collection('messages').find({ roomId: id }).sort({ createdAt: 1 }).toArray();
    return NextResponse.json({ users, messages, owner: room.ownerId });
}
