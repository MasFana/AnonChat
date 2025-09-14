/*
 Migration: Normalize roomId fields to ObjectId

 Collections affected:
  - users.roomId (currently string)
  - messages.roomId
  - polls.roomId (may already be ObjectId or string)
  - votes.roomId
  - signals.roomId

 Strategy:
 1. For each collection (except rooms), scan distinct roomId values.
 2. If value is a 24-hex string and corresponds to an existing room _id, convert that field to ObjectId in-place.
 3. Use bulkWrite for efficiency.
 4. Provide a dry-run mode (set DRY_RUN=1 env) to preview counts.

 After migration, queries can rely on ObjectId roomId.

 Usage (PowerShell examples):
   $env:MONGODB_URI="mongodb+srv://..."; node scripts/migrate-roomid-objectid.ts
   $env:MONGODB_URI="..."; $env:DRY_RUN="1"; node scripts/migrate-roomid-objectid.ts
*/

import { MongoClient, ObjectId, AnyBulkWriteOperation, Document } from 'mongodb';

function isLikelyObjectIdHex(val: unknown): val is string {
    return typeof val === 'string' && /^[a-fA-F0-9]{24}$/.test(val);
}

(async () => {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
        console.error('Missing MONGODB_URI');
        process.exit(1);
    }
    const DRY = process.env.DRY_RUN === '1';
    const client = new MongoClient(uri);
    await client.connect();
    const db = client.db();

    const roomsColl = db.collection('rooms');
    const existingRoomIds = new Set<string>((await roomsColl.find({}, { projection: { _id: 1 } }).toArray()).map(r => r._id.toString()));

    const collections = ['users', 'messages', 'polls', 'votes', 'signals'] as const;

    interface Stat { scanned: number; converted: number; skipped: number; }
    const stats: Record<string, Stat> = {} as Record<string, Stat>;

    for (const name of collections) {
        const col = db.collection(name);
        stats[name] = { scanned: 0, converted: 0, skipped: 0 };

        const distinctRoomIds = await col.distinct('roomId');
        for (const rid of distinctRoomIds) {
            stats[name].scanned++;
            if (!isLikelyObjectIdHex(rid) || !existingRoomIds.has(rid)) {
                stats[name].skipped++;
                continue;
            }
            const oid = new ObjectId(rid);
            if (DRY) {
                const count = await col.countDocuments({ roomId: rid });
                if (count > 0) stats[name].converted += count; // hypothetically
                continue;
            }
            const bulkOps: AnyBulkWriteOperation<Document>[] = [];
            // Update all docs that still have string roomId to ObjectId
            const cursor = col.find({ roomId: rid });
            while (await cursor.hasNext()) {
                const doc = await cursor.next();
                if (!doc) break;
                bulkOps.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { roomId: oid } } } });
                if (bulkOps.length === 500) {
                    await col.bulkWrite(bulkOps);
                    stats[name].converted += bulkOps.length;
                    bulkOps.length = 0;
                }
            }
            if (bulkOps.length) {
                await col.bulkWrite(bulkOps);
                stats[name].converted += bulkOps.length;
            }
        }
    }

    console.table(Object.entries(stats).map(([k, v]) => ({ collection: k, ...v })));
    if (DRY) console.log('Dry run only, no writes performed.');
    await client.close();
})();
