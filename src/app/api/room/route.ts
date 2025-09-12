import { NextRequest, NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/mongodb';

// POST /api/room → create room, assign first user as owner
export async function POST(req: NextRequest) {
    const db = await connectToDatabase();
    const { anonId } = await req.json();
    if (!anonId) return NextResponse.json({ error: 'Missing anonId' }, { status: 400 });
    const room = {
        ownerId: anonId,
        createdAt: new Date(),
    };
    const roomResult = await db.collection('rooms').insertOne(room);
    const roomId = roomResult.insertedId.toString();
    await db.collection('users').insertOne({
        id: anonId,
        roomId,
        lastSeen: new Date(),
        connectedAt: new Date(),
    });
    return NextResponse.json({ roomId, ownerId: anonId });
}

// GET /api/room → list rooms with user counts
export async function GET() {
    try {
        const db = await connectToDatabase();
        const cutoff = new Date(Date.now() - 20000); // 20s recent activity window
        // Build an aggregation that converts _id to string and joins only recently active users
        const pipeline = [
            { $addFields: { _idStr: { $toString: '$_id' } } },
            {
                $lookup: {
                    from: 'users',
                    let: { rid: '$_idStr' },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $and: [
                                        { $eq: ['$roomId', '$$rid'] },
                                        { $gte: ['$lastSeen', cutoff] },
                                    ],
                                },
                            },
                        },
                        { $project: { id: 1 } },
                        // De-duplicate entries by user id (in case of transient duplicates)
                        { $group: { _id: '$id' } },
                    ],
                    as: 'users',
                },
            },
            {
                $project: {
                    _id: 1,
                    _idStr: 1,
                    createdAt: 1,
                    ownerId: 1,
                    userCount: { $size: '$users' },
                    hasOwner: {
                        $gt: [
                            {
                                $size: {
                                    $filter: {
                                        input: '$users',
                                        as: 'u',
                                        cond: { $eq: ['$$u._id', '$ownerId'] },
                                    },
                                },
                            },
                            0,
                        ],
                    },
                },
            },
            { $sort: { createdAt: -1 } },
            { $limit: 100 },
        ];

        const rooms = (await db
            .collection('rooms')
            .aggregate(pipeline)
            .toArray()) as Array<{ _idStr: string; createdAt: Date; userCount: number; hasOwner: boolean }>;
        const normalized = rooms.map((r) => ({
            id: r._idStr,
            createdAt: r.createdAt,
            userCount: r.userCount,
            hasOwner: r.hasOwner,
        }));
        return NextResponse.json({ rooms: normalized });
    } catch {
        return NextResponse.json({ rooms: [], error: 'failed-to-list-rooms' }, { status: 500 });
    }
}
