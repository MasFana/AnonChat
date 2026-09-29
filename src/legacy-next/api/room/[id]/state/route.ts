import { NextRequest, NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/mongodb';
import { ObjectId } from 'mongodb';
import { STALE_USER_PRUNE_MS, MAX_SNAPSHOT_MESSAGES } from '@/lib/constants';
import { deleteRoom } from '@/lib/deleteRoom';

// GET /api/room/[id]/state
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params;
    const db = await connectToDatabase();
    const url = new URL(req.url);
    const anonId = url.searchParams.get('anonId');
    if (!anonId) return NextResponse.json({ error: 'Missing anonId' }, { status: 400 });

    // Update lastSeen for current user
    await db.collection('users').updateOne(
        { id: anonId, roomId: id },
        { $set: { lastSeen: new Date() } }
    );

    // Remove inactive users
    const staleCutoff = new Date(Date.now() - STALE_USER_PRUNE_MS);
    await db.collection('users').deleteMany({ roomId: id, lastSeen: { $lt: staleCutoff } });

    // Get current users and room
    const users = await db.collection('users').find({ roomId: id }).toArray();
    const room = await db.collection('rooms').findOne({ _id: new ObjectId(id) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!room || users.length === 0 || !users.find((u: any) => u.id === room.ownerId)) {
        // Cleanup: delete room, messages, users
        await deleteRoom(id);
        return NextResponse.json({ deleted: true });
    }
    const messages = (await db.collection('messages')
        .find({ roomId: id })
        .sort({ createdAt: -1 })
        .limit(MAX_SNAPSHOT_MESSAGES)
        .toArray()).reverse();
    return NextResponse.json({ users, messages, owner: room.ownerId });
}
