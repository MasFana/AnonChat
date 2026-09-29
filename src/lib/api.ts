export type ApiError = Error & { status?: number; code?: string };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  if (response.ok) return response.json() as Promise<T>;
  const body = await response.json().catch(() => ({})) as { error?: string };
  const error = Object.assign(new Error(body.error || `Request failed (${response.status})`), { status: response.status, code: body.error });
  throw error;
}

const validAnonId = (id: string | null): id is string => !!id && /^anon-[a-z0-9]{10}$/.test(id);

export async function anonId() {
  const saved = localStorage.getItem("anonId");
  if (validAnonId(saved)) return saved;
  const { anonId } = await request<{ anonId: string }>("/api/anon");
  if (!validAnonId(anonId)) throw new Error("invalid_anon_id");
  localStorage.setItem("anonId", anonId);
  return anonId;
}

export const capabilityKey = (roomId: string) => `ownerCapability:${roomId}`;
export const capability = (roomId: string) => sessionStorage.getItem(capabilityKey(roomId)) || undefined;
export const api = {
  request,
  rooms: () => request<{ rooms: RoomSummary[]; stats: RoomStats }>("/api/room"),
  createRoom: (anonId: string) => request<{ roomId: string; ownerId: string; ownerCapability: string }>("/api/room", { method: "POST", body: JSON.stringify({ anonId }) }),
  join: (roomId: string, anonId: string) => request<{ joined: true; ownerId: string }>(`/api/room/${encodeURIComponent(roomId)}/join`, { method: "POST", body: JSON.stringify({ anonId }) }),
  message: (roomId: string, anonId: string, content: string) => request<{ sent: true; id: string }>(`/api/room/${encodeURIComponent(roomId)}/message`, { method: "POST", body: JSON.stringify({ anonId, content }) }),
  visibility: (roomId: string, anonId: string, isPublic: boolean) => request<{ ok: true; isPublic: boolean }>(`/api/room/${encodeURIComponent(roomId)}/visibility`, { method: "PATCH", body: JSON.stringify({ anonId, ownerCapability: capability(roomId), isPublic }) }),
  vote: (roomId: string, pollId: string, anonId: string, optionId: string) => request<{ ok: true }>(`/api/room/${encodeURIComponent(roomId)}/poll/${encodeURIComponent(pollId)}`, { method: "POST", body: JSON.stringify({ anonId, optionId }) }),
};

export type RoomSummary = { id: string; createdAt: string; userCount: number; hasOwner: boolean };
export type RoomStats = { totalRooms: number; activeUsers: number; ownersOnline: number };
export type User = { id: string; connectedAt: string };
export type Message = { id: string; roomId: string; userId: string; content: string; createdAt: string };
export type Poll = { id: string; question: string; options: { id: string; text: string; votes: number }[]; createdAt: string };
export type Snapshot = { users: User[]; messages: Message[]; owner: string; poll: Poll | null; myVote: string | null; isPublic: boolean };