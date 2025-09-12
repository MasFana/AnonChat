import { NextRequest, NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/mongodb';
import { ObjectId } from 'mongodb';

// POST /api/room/[id]/join → join existing room with random anonymous ID
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const db = await connectToDatabase();
  const { id } = await params;
  const { anonId } = await req.json();
  if (!anonId) return NextResponse.json({ error: 'Missing anonId' }, { status: 400 });
  // Only check for room existence if not already joined
  const userExists = await db.collection('users').findOne({ id: anonId, roomId: id });
  if (!userExists) {
    const room = await db.collection('rooms').findOne({ _id: new ObjectId(id) });
    if (!room) return NextResponse.json({ error: 'Room not found' }, { status: 404 });
    await db.collection('users').insertOne({
      id: anonId,
      roomId: id,
      lastSeen: new Date(),
      connectedAt: new Date(),
    });
  }
  return NextResponse.json({ joined: true });
}
