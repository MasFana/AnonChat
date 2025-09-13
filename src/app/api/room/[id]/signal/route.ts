import { NextRequest, NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/mongodb';

// POST /api/room/[id]/signal
// Body: { from, to, data }
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
    const db = await connectToDatabase();
    const { id: roomId } = params;
    const { from, to, data } = await req.json();
    if (!from || !to || !data) return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
    await db.collection('signals').insertOne({ roomId, from, to, data, createdAt: new Date() });
    return NextResponse.json({ ok: true });
}

// GET /api/room/[id]/signal?for=anon-xxxx
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
    const db = await connectToDatabase();
    const { id: roomId } = params;
    const url = new URL(req.url);
    const forId = url.searchParams.get('for');
    if (!forId) return NextResponse.json({ error: 'Missing for' }, { status: 400 });
    const signals = await db.collection('signals').find({ roomId, to: forId }).toArray();
    // Remove after fetching for one-time delivery
    await db.collection('signals').deleteMany({ roomId, to: forId });
    return NextResponse.json({ signals });
}
