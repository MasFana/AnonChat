import { NextRequest, NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/mongodb';
import { ObjectId } from 'mongodb';

// GET /api/room/[id]/meta -> lightweight metadata: ownerId, isPublic, createdAt
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params; // await per Next.js dynamic route guidance
    try {
        const db = await connectToDatabase();
        const room = await db.collection('rooms').findOne({ _id: new ObjectId(id) }, { projection: { ownerId: 1, isPublic: 1, createdAt: 1 } });
        if (!room) return NextResponse.json({ notFound: true }, { status: 404 });
        return NextResponse.json({ ownerId: room.ownerId, isPublic: !!room.isPublic, createdAt: room.createdAt });
    } catch {
        return NextResponse.json({ error: 'meta-failed' }, { status: 500 });
    }
}
