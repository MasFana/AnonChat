import { MongoClient, Db } from 'mongodb';

const uri = process.env.MONGODB_URI || '';
let client: MongoClient;
let db: Db;

export async function connectToDatabase() {
    if (!uri) throw new Error('Please define the MONGODB_URI environment variable');
    if (db) return db;
    if (!client) {
        client = new MongoClient(uri);
        await client.connect();
    }
    db = client.db();
    return db;
}
