import { NextRequest, NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/mongodb';
import { ObjectId } from 'mongodb';
import { roomEventBus } from '@/lib/events';

// PATCH /api/room/[id]/visibility  { anonId, isPublic }
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params; // await per Next.js dynamic route guidance
    const { anonId, isPublic } = await req.json();
    if (!anonId || typeof isPublic !== 'boolean') return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
    try {
        const db = await connectToDatabase();
        const room = await db.collection('rooms').findOne({ _id: new ObjectId(id) });
        if (!room) return NextResponse.json({ error: 'Room not found' }, { status: 404 });
        if (room.ownerId !== anonId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        await db.collection('rooms').updateOne({ _id: new ObjectId(id) }, { $set: { isPublic } });
        roomEventBus.publish(id, { type: 'room-visibility', payload: { roomId: id, isPublic } });
        return NextResponse.json({ ok: true, isPublic });
    } catch {
        return NextResponse.json({ error: 'toggle-failed' }, { status: 500 });
    }
}
