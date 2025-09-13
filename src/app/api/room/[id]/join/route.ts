import { NextRequest, NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/mongodb';
import { ObjectId } from 'mongodb';
import { roomEventBus } from '@/lib/events';

// POST /api/room/[id]/join → join existing room with random anonymous ID
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params; // await params per Next.js guidance
    const db = await connectToDatabase();
    const { anonId } = await req.json();
    if (!anonId || typeof anonId !== 'string' || anonId.length > 64) {
        return NextResponse.json({ error: 'Invalid anonId' }, { status: 400 });
    }
    // Ensure room exists (but allow joining whether listed or hidden)
    const room = await db.collection('rooms').findOne({ _id: new ObjectId(id) });
    if (!room) return NextResponse.json({ error: 'Room not found' }, { status: 404 });

    const existing = await db.collection('users').findOne({ id: anonId, roomId: id });
    if (!existing) {
        await db.collection('users').insertOne({ id: anonId, roomId: id, lastSeen: new Date(), connectedAt: new Date() });
    } else {
        await db.collection('users').updateOne({ _id: existing._id }, { $set: { lastSeen: new Date() } });
    }
    const users = await db.collection('users').find({ roomId: id }).toArray();
    roomEventBus.publish(id, { type: 'users', payload: users });
    return NextResponse.json({ joined: true, ownerId: room.ownerId });
}
