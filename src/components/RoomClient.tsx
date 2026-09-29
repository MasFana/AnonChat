"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { anonId, api, type Message, type Poll, type Snapshot, type User } from "@/lib/api";

export default function RoomClient({ roomId }: { roomId: string }) {
  const [id, setId] = useState(""); const [users, setUsers] = useState<User[]>([]); const [messages, setMessages] = useState<Message[]>([]);
  const [owner, setOwner] = useState(""); const [poll, setPoll] = useState<Poll | null>(null); const [isPublic, setPublic] = useState(false); const [content, setContent] = useState(""); const [error, setError] = useState("");
  const last = useRef(0);
  useEffect(() => { anonId().then(setId).catch(() => setError("Cannot establish anonymous identity.")); }, []);
  useEffect(() => {
    if (!id) return; let source: EventSource | undefined;
    const apply = (type: string, value: unknown, seq: number) => {
      if (seq && seq <= last.current) return; if (seq) last.current = seq;
      if (type === "snapshot") { const state = value as Snapshot; setUsers(state.users); setMessages(state.messages.slice(-100)); setOwner(state.owner); setPoll(state.poll); setPublic(state.isPublic); }
      if (type === "message") setMessages(items => [...items, value as Message].slice(-100));
      if (type === "users") setUsers(value as User[]); if (type === "poll") setPoll(value as Poll | null);
      if (type === "vote") setPoll(current => current ? { ...current, options: (value as { options: Poll["options"] }).options } : current);
      if (type === "room-visibility") setPublic((value as { isPublic: boolean }).isPublic);
      if (type === "room-deleted") { source?.close(); location.assign("/?msg=Room%20Closed"); }
    };
    source = new EventSource(`/api/room/${encodeURIComponent(roomId)}/sse?anonId=${encodeURIComponent(id)}`);
    ["snapshot", "message", "users", "poll", "vote", "room-visibility", "room-deleted"].forEach(type => source!.addEventListener(type, event => { try { const data = JSON.parse((event as MessageEvent).data) as { seq?: number; payload: unknown }; apply(type, data.payload, data.seq || Number((event as MessageEvent).lastEventId)); } catch { setError("Invalid live update."); } }));
    source.onerror = () => setError("Live connection reconnecting."); return () => source?.close();
  }, [id, roomId]);
  const send = async (event: React.FormEvent) => { event.preventDefault(); const text = content.trim(); if (!text || !id) return; try { await api.message(roomId, id, text); setContent(""); } catch (e) { setError(e instanceof Error ? e.message : "Cannot send message."); } };
  const ownerHere = id === owner;
  return <main className="min-h-screen bg-background text-foreground"><div className="max-w-6xl mx-auto p-4 sm:p-6"><Link className="text-sm text-muted-foreground hover:text-foreground" href="/">← Rooms</Link><header className="mt-4 flex flex-wrap gap-3 items-center justify-between"><div><h1 className="text-2xl font-bold">Room {roomId}</h1><p className="text-sm text-muted-foreground">{users.length} connected</p></div>{ownerHere && <button className="px-3 py-2 rounded border border-border" onClick={() => api.visibility(roomId, id, !isPublic).catch(e => setError(e.message))}>{isPublic ? "Public" : "Private"}</button>}</header>{error && <p className="mt-3 text-sm text-amber-300">{error}</p>}<div className="mt-6 grid gap-5 lg:grid-cols-[1fr_280px]"><section className="rounded-lg border border-border bg-card p-4"><div className="h-[55vh] overflow-y-auto space-y-3">{messages.map(message => <article key={message.id} className="rounded bg-muted/50 p-3"><b className="text-sm">{message.userId === id ? "You" : message.userId}</b><p className="break-words">{message.content}</p><time className="text-xs text-muted-foreground">{new Date(message.createdAt).toLocaleString()}</time></article>)}</div><form onSubmit={send} className="mt-4 flex gap-2"><input aria-label="Message" maxLength={1000} value={content} onChange={e => setContent(e.target.value)} className="min-w-0 flex-1 rounded border border-input bg-background px-3 py-2"/><button className="rounded bg-primary px-4 py-2 text-primary-foreground">Send</button></form></section><aside className="space-y-5"><section className="rounded-lg border border-border bg-card p-4"><h2 className="font-semibold">People</h2><ul className="mt-3 space-y-2 text-sm">{users.map(user => <li key={user.id}>{user.id === owner ? "Owner: " : ""}{user.id}</li>)}</ul></section>{poll && <section className="rounded-lg border border-border bg-card p-4"><h2 className="font-semibold">{poll.question}</h2><div className="mt-3 space-y-2">{poll.options.map(option => <button key={option.id} onClick={() => api.vote(roomId, poll.id, id, option.id).catch(e => setError(e.message))} className="w-full rounded border border-border p-2 text-left">{option.text} <span className="float-right">{option.votes}</span></button>)}</div></section>}</aside></div></div></main>;
}