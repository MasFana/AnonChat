import { NextRequest, NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/mongodb';
import { ObjectId } from 'mongodb';
import { roomEventBus } from '@/lib/events';
import { schedulePollsReplace, immediatePollsReplace } from '@/lib/pollsSync';

type PollOptionDoc = { _id: ObjectId; text: string; votes: number };
// roomId may be stored as string (new) or ObjectId (legacy) in some docs
type PollDoc = { _id: ObjectId; roomId: string | ObjectId; question: string; options: PollOptionDoc[]; active: boolean; createdAt: Date; updatedAt: Date };

// PATCH /api/room/[id]/poll/[pollId] -> update (active flag, question, options?) owner only
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string; pollId: string }> }) {
    const { id: roomId, pollId } = await ctx.params;
    const db = await connectToDatabase();
    const body = await req.json();
    const { anonId } = body as { anonId?: string };
    if (!ObjectId.isValid(pollId)) {
        return NextResponse.json({ error: 'Invalid pollId', errorCode: 'invalidPollId', pollId }, { status: 400 });
    }
    let active: boolean | undefined = undefined;
    if (typeof body.active === 'boolean') active = body.active;
    else if (typeof body.active === 'string') active = body.active === 'true';
    if (!anonId || typeof active === 'undefined') return NextResponse.json({ error: 'Missing anonId or active', errorCode: 'missingFields' }, { status: 400 });
    const room = await db.collection('rooms').findOne({ _id: new ObjectId(roomId) });
    if (!room) return NextResponse.json({ error: 'Room not found', errorCode: 'roomNotFound', roomId }, { status: 404 });
    if (room.ownerId !== anonId) return NextResponse.json({ error: 'Forbidden', errorCode: 'forbiddenNotOwner' }, { status: 403 });
    // Find by _id and match roomId (string or ObjectId)
    const existing = (await db.collection('polls').findOne({
        _id: new ObjectId(pollId),
        $or: [{ roomId }, { roomId: new ObjectId(roomId) }],
    })) as PollDoc | null;
    if (!existing) return NextResponse.json({ error: 'Poll not found', errorCode: 'pollByIdOrRoomNotFound', roomId, pollId }, { status: 404 });
    // Short-circuit if no change
    if (existing.active === active) {
        return NextResponse.json({ ok: true, unchanged: true, poll: { ...existing, _id: existing._id.toString(), options: existing.options.map(o => ({ ...o, _id: o._id.toString() })) } });
    }
    const res = await db
        .collection('polls')
        .findOneAndUpdate({ _id: new ObjectId(pollId), $or: [{ roomId }, { roomId: new ObjectId(roomId) }] }, { $set: { active, updatedAt: new Date() } }, { returnDocument: 'after' });
    let updated = res?.value as PollDoc | undefined;
    if (!updated) {
        // Fallback: refetch in case race changed it to desired value already
        const refetched = await db.collection('polls').findOne({ _id: new ObjectId(pollId), $or: [{ roomId }, { roomId: new ObjectId(roomId) }] }) as PollDoc | null;
        if (refetched && refetched.active === active) {
            updated = refetched; // treat as success (idempotent)
        } else {
            return NextResponse.json({ error: 'Poll not found', errorCode: 'updateReturnedNull', roomId, pollId }, { status: 404 });
        }
    }
    // Immediate minimal delta event for fast UI update
    roomEventBus.publish(roomId, {
        type: 'poll-updated',
        payload: { _id: updated._id.toString(), active: updated.active }
    });
    // Debounced full-list broadcast for eventual consistency (coalesces rapid toggles)
    schedulePollsReplace(roomId);
    return NextResponse.json({
        ok: true, poll: {
            ...updated,
            _id: updated._id.toString(),
            options: (updated.options || []).map((o) => ({ ...o, _id: o._id.toString() })),
        }
    });
}

// DELETE /api/room/[id]/poll/[pollId] -> owner only
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string; pollId: string }> }) {
    const { id: roomId, pollId } = await ctx.params;
    const db = await connectToDatabase();
    let anonId: string | undefined;
    try {
        const body = await req.json().catch(() => null);
        if (body && typeof body.anonId === 'string') anonId = body.anonId;
    } catch { /* ignore */ }
    if (!ObjectId.isValid(pollId)) return NextResponse.json({ error: 'Invalid pollId', errorCode: 'invalidPollId', pollId }, { status: 400 });
    if (!anonId) return NextResponse.json({ error: 'Missing anonId', errorCode: 'missingAnonId' }, { status: 400 });
    const room = await db.collection('rooms').findOne({ _id: new ObjectId(roomId) });
    if (!room) return NextResponse.json({ error: 'Room not found', errorCode: 'roomNotFound', roomId }, { status: 404 });
    if (room.ownerId !== anonId) return NextResponse.json({ error: 'Forbidden', errorCode: 'forbiddenNotOwner' }, { status: 403 });

    // Attempt atomic delete; treat missing as already-deleted (idempotent behavior)
    const res = await db.collection('polls').findOneAndDelete({ _id: new ObjectId(pollId), $or: [{ roomId }, { roomId: new ObjectId(roomId) }] });
    if (!res || !res.value) {
        // Already deleted: still emit deletion + refreshed list so late-joining clients sync
        roomEventBus.publish(roomId, { type: 'poll-deleted', payload: { _id: pollId, already: true } });
        await immediatePollsReplace(roomId);
        schedulePollsReplace(roomId);
        return NextResponse.json({ ok: true, alreadyDeleted: true });
    } else {
        // Clean up votes only after confirming poll existed
        await db.collection('votes').deleteMany({ pollId });
        roomEventBus.publish(roomId, { type: 'poll-deleted', payload: { _id: pollId } });
        // Immediately broadcast authoritative list so non-owners update instantly
        await immediatePollsReplace(roomId);
        // Also schedule (will noop if rapid further changes get batched)
        schedulePollsReplace(roomId);
        return NextResponse.json({ ok: true, deleted: true });
    }
}

// POST /api/room/[id]/poll/[pollId] -> vote
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string; pollId: string }> }) {
    const { id: roomId, pollId } = await ctx.params;
    const db = await connectToDatabase();
    const { anonId, optionId } = await req.json();
    if (!ObjectId.isValid(pollId)) return NextResponse.json({ error: 'Invalid pollId', errorCode: 'invalidPollId', pollId }, { status: 400 });
    if (!anonId || !optionId) return NextResponse.json({ error: 'Missing anonId or optionId', errorCode: 'missingFields' }, { status: 400 });
    const poll = (await db.collection('polls').findOne({ _id: new ObjectId(pollId), $or: [{ roomId }, { roomId: new ObjectId(roomId) }] })) as PollDoc | null;
    if (!poll) return NextResponse.json({ error: 'Poll not found', errorCode: 'pollByIdOrRoomNotFound', roomId, pollId }, { status: 404 });
    if (!poll.active) return NextResponse.json({ error: 'Poll is closed', errorCode: 'pollClosed' }, { status: 400 });

    // Prevent duplicate voting by same anonId per poll
    const existingVote = await db.collection('votes').findOne({ pollId, anonId });
    if (!existingVote) {
        // First time vote
        await db.collection('votes').insertOne({ pollId, roomId, anonId, optionId, createdAt: new Date() });
        await db
            .collection('polls')
            .updateOne({ _id: new ObjectId(pollId), 'options._id': new ObjectId(optionId) }, { $inc: { 'options.$.votes': 1 }, $set: { updatedAt: new Date() } });
    } else if (existingVote.optionId !== optionId) {
        // Change vote: decrement previous, increment new, update vote doc
        await db
            .collection('polls')
            .updateOne({ _id: new ObjectId(pollId), 'options._id': new ObjectId(existingVote.optionId) }, { $inc: { 'options.$.votes': -1 }, $set: { updatedAt: new Date() } });
        await db
            .collection('polls')
            .updateOne({ _id: new ObjectId(pollId), 'options._id': new ObjectId(optionId) }, { $inc: { 'options.$.votes': 1 }, $set: { updatedAt: new Date() } });
        await db.collection('votes').updateOne({ _id: existingVote._id }, { $set: { optionId, roomId, updatedAt: new Date() } });
    } else {
        // Same vote option; nothing to change
        return NextResponse.json({ ok: true });
    }

    const updated = (await db.collection('polls').findOne({ _id: new ObjectId(pollId) })) as PollDoc | null;
    if (updated) {
        roomEventBus.publish(roomId, {
            type: 'vote-cast',
            payload: {
                pollId,
                anonId,
                optionId,
                poll: {
                    ...updated,
                    _id: updated._id.toString(),
                    options: (updated.options || []).map((o) => ({ ...o, _id: o._id.toString() })),
                },
            },
        });
    }
    return NextResponse.json({ ok: true });
}
