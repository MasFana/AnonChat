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
        isPublic: false,
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
        // Public rooms list pipeline
        const pipeline = [
            { $match: { isPublic: true } },
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
            { $project: { _id: 1, _idStr: 1, createdAt: 1, ownerId: 1, isPublic: 1, userCount: { $size: '$users' }, hasOwner: { $gt: [{ $size: { $filter: { input: '$users', as: 'u', cond: { $eq: ['$$u._id', '$ownerId'] } } } }, 0] } } },
            { $sort: { createdAt: -1 } },
            { $limit: 100 },
        ];

        const rooms = (await db.collection('rooms').aggregate(pipeline).toArray()) as Array<{ _idStr: string; createdAt: Date; userCount: number; hasOwner: boolean; isPublic: boolean }>;
        const normalized = rooms.map((r) => ({ id: r._idStr, createdAt: r.createdAt, userCount: r.userCount, hasOwner: r.hasOwner }));

        // Aggregate stats across all rooms (public + private)
        const allRooms = await db.collection('rooms').find({}).project({ _id: 1, ownerId: 1, isPublic: 1 }).toArray();
        const roomIds = allRooms.map(r => r._id.toString());
        let activeUsers = 0; let ownersOnline = 0; const totalRooms = allRooms.length;
        if (roomIds.length > 0) {
            const usersAgg = await db.collection('users').aggregate([
                { $match: { roomId: { $in: roomIds }, lastSeen: { $gte: cutoff } } },
                { $group: { _id: '$id' } },
            ]).toArray();
            activeUsers = usersAgg.length;
            // Owners online: owners with a recent user record
            const ownerIds = allRooms.map(r => r.ownerId).filter(Boolean);
            if (ownerIds.length) {
                const ownersSet = new Set(ownerIds);
                const ownersActive = await db.collection('users').aggregate([
                    { $match: { id: { $in: Array.from(ownersSet) }, lastSeen: { $gte: cutoff } } },
                    { $group: { _id: '$id' } },
                ]).toArray();
                ownersOnline = ownersActive.length;
            }
        }
        return NextResponse.json({ rooms: normalized, stats: { totalRooms, activeUsers, ownersOnline } });
    } catch {
        return NextResponse.json({ rooms: [], stats: { totalRooms: 0, activeUsers: 0, ownersOnline: 0 }, error: 'failed-to-list-rooms' }, { status: 500 });
    }
}
