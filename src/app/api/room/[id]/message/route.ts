import { NextRequest, NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/mongodb';
import { ObjectId } from 'mongodb';
import { roomEventBus } from '@/lib/events';

// POST /api/room/[id]/message → send a chat message
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const db = await connectToDatabase();
    const { id } = await params;
    const { anonId, content } = await req.json();
    if (!anonId || !content) return NextResponse.json({ error: 'Missing anonId or content' }, { status: 400 });
    // Only check for room existence if not already joined
    const userExists = await db.collection('users').findOne({ id: anonId, roomId: id });
    if (!userExists) {
        const room = await db.collection('rooms').findOne({ _id: new ObjectId(id) });
        if (!room) return NextResponse.json({ error: 'Room not found' }, { status: 404 });
    }
    const msg = {
        roomId: id,
        userId: anonId,
        content,
        createdAt: new Date(),
    };
    const insertRes = await db.collection('messages').insertOne(msg);
    const out = { ...msg, id: insertRes.insertedId.toString() };
    roomEventBus.publish(id, { type: 'message', payload: out });
    return NextResponse.json({ sent: true, id: out.id });
}
