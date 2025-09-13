/**
 * Migration: Set isPublic:true for legacy rooms missing the field.
 * Usage (TS Node via ts-node/register or ts-node):
 *   npx ts-node scripts/migrate-set-public.ts
 * Or compile with tsc then run with node.
 *
 * This will:
 * 1. Connect to MongoDB using MONGODB_URI
 * 2. Update all documents in `rooms` where `isPublic` does not exist, setting it to true
 * 3. Log summary and exit
 */

import { MongoClient } from 'mongodb';

async function run() {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
        console.error('Missing MONGODB_URI environment variable.');
        process.exit(1);
    }
    const client = new MongoClient(uri);
    try {
        await client.connect();
        const db = client.db();
        const roomsCol = db.collection('rooms');
        const filter = { isPublic: { $exists: false } };
        const update = { $set: { isPublic: true } };
        const res = await roomsCol.updateMany(filter, update);
        console.log(`Migration complete. Matched: ${res.matchedCount}, Modified: ${res.modifiedCount}`);
    } catch (err) {
        console.error('Migration failed', err);
        process.exitCode = 1;
    } finally {
        await client.close();
    }
}

run();
