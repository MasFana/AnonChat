import { limits, validText } from "@/lib/limits";
export type ApiError = Error & { status?: number; code?: string };
const roomPath = (roomId: string, tail = "") => `/api/room/${encodeURIComponent(roomId)}${tail}`;

async function request<T>(path: string, init?: RequestInit, retriedIdentity = false): Promise<T> {
  const response = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  if (response.ok) return response.json() as Promise<T>;
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (body.error === "invalid_anon_id" && !retriedIdentity && init?.body && typeof window !== "undefined") {
    localStorage.removeItem("anonId");
    const identityResponse = await fetch("/api/anon");
    const identity = await identityResponse.json().catch(() => ({})) as { anonId?: string };
    const replacementId = identity.anonId && validAnonId(identity.anonId) ? identity.anonId : null;
    if (identityResponse.ok && replacementId) {
      const payload = JSON.parse(String(init.body)) as { anonId?: string };
      payload.anonId = replacementId;
      localStorage.setItem("anonId", replacementId);
      return request<T>(path, { ...init, body: JSON.stringify(payload) }, true);
    }
  }
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
export const capability = (roomId: string) => typeof window === "undefined" ? undefined : sessionStorage.getItem(capabilityKey(roomId)) || undefined;
export const api = {
  request,
  rooms: () => request<{ rooms: RoomSummary[]; stats: RoomStats }>("/api/room"),
  createRoom: (anonId: string) => request<{ roomId: string; ownerId: string; ownerCapability: string }>("/api/room", { method: "POST", body: JSON.stringify({ anonId }) }),
  join: (roomId: string, anonId: string) => request<{ joined: true; ownerId: string }>(roomPath(roomId, "/join"), { method: "POST", body: JSON.stringify({ anonId }) }),
  meta: (roomId: string) => request<{ ownerId: string; isPublic: boolean; createdAt: string }>(roomPath(roomId, "/meta")),
  state: (roomId: string, anonId: string) => request<Snapshot>(`${roomPath(roomId, "/state")}?anonId=${encodeURIComponent(anonId)}`),
  message: (roomId: string, anonId: string, content: string) => { if (!validText(content, limits.messageBytes)) return Promise.reject(new Error("invalid_message")); return request<{ sent: true; id: string }>(roomPath(roomId, "/message"), { method: "POST", body: JSON.stringify({ anonId, content: content.trim() }) }); },
  visibility: (roomId: string, anonId: string, isPublic: boolean) => request<{ ok: true; isPublic: boolean }>(roomPath(roomId, "/visibility"), { method: "PATCH", body: JSON.stringify({ anonId, ownerCapability: capability(roomId), isPublic }) }),
  poll: (roomId: string) => request<{ poll: Poll | null }>(roomPath(roomId, "/poll")),
  createPoll: (roomId: string, anonId: string, question: string, options: string[]) => request<{ pollId: string }>(roomPath(roomId, "/poll"), { method: "POST", body: JSON.stringify({ anonId, ownerCapability: capability(roomId), question, options }) }),
  vote: (roomId: string, pollId: string, anonId: string, optionId: string) => request<{ ok: true }>(roomPath(roomId, `/poll/${encodeURIComponent(pollId)}`), { method: "POST", body: JSON.stringify({ anonId, optionId }) }),
  closePoll: (roomId: string, pollId: string, anonId: string) => request<{ ok: true }>(roomPath(roomId, `/poll/${encodeURIComponent(pollId)}`), { method: "PATCH", body: JSON.stringify({ anonId, ownerCapability: capability(roomId), active: false }) }),
  deletePoll: (roomId: string, pollId: string, anonId: string) => request<{ ok: true; deleted: true }>(roomPath(roomId, `/poll/${encodeURIComponent(pollId)}`), { method: "DELETE", body: JSON.stringify({ anonId, ownerCapability: capability(roomId) }) }),
  sse: (roomId: string, anonId: string) => `${roomPath(roomId, "/sse")}?anonId=${encodeURIComponent(anonId)}`,
};

export type RoomSummary = { id: string; createdAt: string; userCount: number; hasOwner: boolean };
export type RoomStats = { totalRooms: number; activeUsers: number; ownersOnline: number };
export type User = { id: string; connectedAt: string };
export type Message = { id: string; roomId: string; userId: string; content: string; createdAt: string };
export type Poll = { id: string; question: string; options: { id: string; text: string; votes: number }[]; createdAt: string };
export type Snapshot = { users: User[]; messages: Message[]; owner: string; poll: Poll | null; myVote: string | null; isPublic: boolean };