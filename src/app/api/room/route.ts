import { NextRequest, NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/mongodb';
import { ObjectId } from 'mongodb';

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
