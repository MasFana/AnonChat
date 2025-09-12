import { NextRequest, NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/mongodb';
import { ObjectId } from 'mongodb';
import { roomEventBus } from '@/lib/events';
import { schedulePollsReplace, immediatePollsReplace } from '@/lib/pollsSync';
type PollOptionDoc = { _id: ObjectId; text: string; votes: number };
// roomId may be string or ObjectId depending on creation time
type PollDoc = { _id: ObjectId; roomId: string | ObjectId; question: string; options: PollOptionDoc[]; active: boolean; createdAt: Date; updatedAt: Date };

// POST /api/room/[id]/poll -> create poll (owner only)
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const db = await connectToDatabase();
    const { id: roomId } = await params;
    const { anonId, question, options } = await req.json();
    if (!anonId || !question || !Array.isArray(options) || options.length < 2) {
        return NextResponse.json({ error: 'Missing or invalid fields' }, { status: 400 });
    }
    const room = await db.collection('rooms').findOne({ _id: new ObjectId(roomId) });
    if (!room) return NextResponse.json({ error: 'Room not found' }, { status: 404 });
    if (room.ownerId !== anonId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const now = new Date();
    const pollDoc = {
        roomId,
        question,
        options: options.map((text: string) => ({ _id: new ObjectId(), text, votes: 0 })),
        active: true,
        createdAt: now,
        updatedAt: now,
    };
    const result = await db.collection('polls').insertOne(pollDoc);
    const poll = { ...pollDoc, _id: result.insertedId } as const;
    const plain = {
        ...poll,
        _id: poll._id.toString(),
        options: poll.options.map((o) => ({ ...o, _id: o._id.toString() })),
    };
    roomEventBus.publish(roomId, { type: 'poll-created', payload: plain });
    // Immediately push new list so all clients see new poll right away
    await immediatePollsReplace(roomId);
    // Schedule debounced replace to catch rapid successive creates
    schedulePollsReplace(roomId);
    return NextResponse.json({ pollId: result.insertedId.toString() });
}

// GET /api/room/[id]/poll -> list polls
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const db = await connectToDatabase();
    const { id: roomId } = await params;
    const polls = (await db
        .collection('polls')
        .find({ $or: [{ roomId }, { roomId: new ObjectId(roomId) }] })
        .sort({ createdAt: -1 })
        .toArray()) as PollDoc[];
    const normalized = polls.map((p) => ({
        ...p,
        _id: p._id.toString(),
        options: (p.options || []).map((o) => ({ ...o, _id: o._id.toString() })),
    }));
    return NextResponse.json({ polls: normalized });
}
