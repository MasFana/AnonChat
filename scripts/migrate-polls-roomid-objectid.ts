/**
 * Migration: Convert string roomId fields in polls collection to ObjectId.
 *
 * Context: After refactor, polls are now queried with { roomId: ObjectId(...) } only.
 * Legacy documents may still store roomId as a string. This script upgrades those.
 *
 * Usage (PowerShell):
 *   $env:MONGODB_URI="mongodb+srv://..."; node -r ts-node/register scripts/migrate-polls-roomid-objectid.ts
 *
 * Safe to re-run: skips docs already converted.
 */
import { ObjectId } from 'mongodb';
import { connectToDatabase } from '@/lib/mongodb';

async function run() {
  const db = await connectToDatabase();
  const polls = db.collection('polls');

  const cursor = polls.find({ roomId: { $type: 'string' } });
  let scanned = 0;
  let converted = 0;
  while (await cursor.hasNext()) {
    const doc: any = await cursor.next();
    scanned++;
    const roomIdStr = doc.roomId;
    if (typeof roomIdStr === 'string' && ObjectId.isValid(roomIdStr)) {
      await polls.updateOne({ _id: doc._id, roomId: roomIdStr }, { $set: { roomId: new ObjectId(roomIdStr) } });
      converted++;
    }
  }
  console.log(JSON.stringify({ scanned, converted }));
  process.exit(0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
