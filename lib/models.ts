// Data models for MongoDB collections

export interface Room {
    id: string; // room id (ObjectId as string)
    ownerId: string; // user id of owner
    createdAt: Date;
}

export interface User {
    id: string; // user id (ObjectId as string or anon-xxxx)
    roomId: string; // room id
    lastSeen: Date;
    connectedAt: Date;
}

export interface Message {
    id: string; // message id (ObjectId as string)
    roomId: string;
    userId: string;
    content: string;
    createdAt: Date;
}
