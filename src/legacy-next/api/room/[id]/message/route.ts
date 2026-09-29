import { NextRequest, NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/mongodb';
import { ObjectId } from 'mongodb';
import { roomEventBus } from '@/lib/events';

// POST /api/room/[id]/message → send a chat message
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params; // await per Next.js dynamic route guidance
    const db = await connectToDatabase();
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const anonId = typeof body.anonId === 'string' ? body.anonId.slice(0, 64) : '';
    let content = typeof body.content === 'string' ? body.content : '';
    if (!anonId || !content) return NextResponse.json({ error: 'Missing anonId or content' }, { status: 400 });
    // Normalize + cap message length (basic DoS mitigation)
    content = content.trim().slice(0, 1000);
    if (!content) return NextResponse.json({ error: 'Empty content' }, { status: 400 });
    // Ensure room exists (even if user not explicitly joined yet) & user presence record optional
    const room = await db.collection('rooms').findOne({ _id: new ObjectId(id) });
    if (!room) return NextResponse.json({ error: 'Room not found' }, { status: 404 });
    const userExists = await db.collection('users').findOne({ id: anonId, roomId: id });
    if (!userExists) {
        // Auto-register lightweight presence row
        await db.collection('users').insertOne({ id: anonId, roomId: id, lastSeen: new Date(), connectedAt: new Date() });
    }
    const msg = { roomId: id, userId: anonId, content, createdAt: new Date() };
    const insertRes = await db.collection('messages').insertOne(msg);
    const out = { ...msg, id: insertRes.insertedId.toString() };
    roomEventBus.publish(id, { type: 'message', payload: out });
    return NextResponse.json({ sent: true, id: out.id });
}
