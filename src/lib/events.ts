// Simple in-memory event bus for room-scoped Server-Sent Events
// Note: In development with hot reload, this will reset; that's acceptable.

export type RoomEvent = {
    type:
    | "snapshot"
    | "message"
    | "users"
    | "room-deleted"
    | "poll-created"
    | "poll-updated" // reintroduced for instant toggle
    | "poll-deleted"
    | "polls-replace"
    | "vote-cast"
    | "ping";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    payload?: any;
};

type Subscriber = (event: RoomEvent) => void;

class RoomEventBus {
    private subscribers: Map<string, Set<Subscriber>> = new Map();

    subscribe(roomId: string, fn: Subscriber): () => void {
        const set = this.subscribers.get(roomId) ?? new Set<Subscriber>();
        set.add(fn);
        this.subscribers.set(roomId, set);
        return () => {
            const cur = this.subscribers.get(roomId);
            if (!cur) return;
            cur.delete(fn);
            if (cur.size === 0) this.subscribers.delete(roomId);
        };
    }

    publish(roomId: string, event: RoomEvent) {
        const set = this.subscribers.get(roomId);
        if (!set || set.size === 0) return;
        for (const fn of set) {
            try {
                fn(event);
            } catch {
                // ignore subscriber errors
            }
        }
    }

    subscriberCount(roomId: string) {
        return this.subscribers.get(roomId)?.size ?? 0;
    }
}

// Ensure a single bus instance across HMR/route module reloads
declare global {
    // Using var on purpose to attach to Node global
    var __roomEventBus: RoomEventBus | undefined;
}

const g = globalThis as unknown as { __roomEventBus?: RoomEventBus };
export const roomEventBus: RoomEventBus = g.__roomEventBus || new RoomEventBus();
g.__roomEventBus = roomEventBus;
