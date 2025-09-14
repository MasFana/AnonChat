/*
 Index creation script.

 Includes:
  - TTL on users.lastSeen (expireAfterSeconds = 60) for safety (server also prunes actively).
  - Unique (roomId, id) on users to prevent duplicates for same anon in same room.
  - Unique (pollId, anonId) on votes to prevent double voting.
  - Supporting indexes for frequent queries.
  - Messages: (roomId, createdAt) for ordered fetch.
  - Polls: (roomId, createdAt) and active polls by room.

 Adjust TTL seconds with USERS_LASTSEEN_TTL env if desired.

 Usage (PowerShell):
   $env:MONGODB_URI="..."; node scripts/create-indexes.ts
*/

import { MongoClient } from 'mongodb';

(async () => {
    const uri = process.env.MONGODB_URI;
    if (!uri) { console.error('Missing MONGODB_URI'); process.exit(1); }
    const client = new MongoClient(uri);
    await client.connect();
    const db = client.db();

    const ttlSeconds = parseInt(process.env.USERS_LASTSEEN_TTL || '', 10) || 60;

    // Users collection indexes
    await db.collection('users').createIndex({ roomId: 1, id: 1 }, { unique: true, name: 'uniq_room_user' }).catch(() => { });
    await db.collection('users').createIndex({ lastSeen: 1 }, { expireAfterSeconds: ttlSeconds, name: 'ttl_lastSeen' }).catch(() => { });
    await db.collection('users').createIndex({ roomId: 1, lastSeen: 1 }, { name: 'room_recent_users' }).catch(() => { });

    // Messages
    await db.collection('messages').createIndex({ roomId: 1, createdAt: 1 }, { name: 'room_messages_chrono' }).catch(() => { });
    await db.collection('messages').createIndex({ roomId: 1, createdAt: -1 }, { name: 'room_messages_reverse' }).catch(() => { });

    // Polls
    await db.collection('polls').createIndex({ roomId: 1, createdAt: -1 }, { name: 'room_polls_newest' }).catch(() => { });
    await db.collection('polls').createIndex({ roomId: 1, active: 1 }, { name: 'room_active_polls' }).catch(() => { });

    // Votes
    await db.collection('votes').createIndex({ pollId: 1, anonId: 1 }, { unique: true, name: 'uniq_vote' }).catch(() => { });
    await db.collection('votes').createIndex({ roomId: 1, pollId: 1 }, { name: 'room_poll_votes' }).catch(() => { });

    // Signals (ephemeral) - optional helpful index
    try { await db.collection('signals').createIndex({ roomId: 1, createdAt: 1 }, { name: 'room_signals_chrono' }); } catch { }

    console.log('Index creation attempted (existing indexes are ignored).');
    await client.close();
})();
