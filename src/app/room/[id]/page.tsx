"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Users, MessageCircle, ChevronDown } from "lucide-react";

interface User {
    id: string;
    roomId: string;
    lastSeen: string;
    connectedAt: string;
}
interface Message {
    id?: string;
    roomId: string;
    userId: string;
    content: string;
    createdAt: string;
}

import React from "react";
import Link from "next/link";

interface PollOptionClient { _id: string; text: string; votes: number }
interface PollClient { _id: string; roomId: string; question: string; options: PollOptionClient[]; active: boolean; createdAt: string; updatedAt: string }
export default function RoomPage({ params }: { params: Promise<{ id: string }> }) {
    const router = useRouter();
    const [users, setUsers] = useState<User[]>([]);
    const [messages, setMessages] = useState<Message[]>([]);
    const [owner, setOwner] = useState<string>("");
    const [polls, setPolls] = useState<PollClient[]>([]);
    const lastVersionRef = useRef(0); // tracks latest polls version applied
    const [content, setContent] = useState("");
    const [myVotes, setMyVotes] = useState<Record<string, string>>({});
    const [loading, setLoading] = useState(false);
    const sseRef = useRef<EventSource | null>(null);
    const messagesContainerRef = useRef<HTMLDivElement | null>(null);
    const { id: roomId } = React.use(params);
    const anonId = typeof window !== "undefined" ? localStorage.getItem("anonId") : null;

    const dedupedUsers = React.useMemo(() => {
        const seen = new Set<string>();
        const list: User[] = [];
        for (const u of users) {
            if (seen.has(u.id)) continue;
            seen.add(u.id);
            list.push(u);
        }
        return list;
    }, [users]);

    useEffect(() => {
        const el = messagesContainerRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
    }, [messages]);

    useEffect(() => {
        if (!anonId) {
            router.replace("/?msg=missing-id");
            return;
        }
        let cancelled = false;
        let reconcileInterval: NodeJS.Timeout | null = null; // light fallback interval reference
        const joinAndSubscribe = async () => {
            await fetch(`/api/room/${roomId}/join`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ anonId }),
            });
            if (cancelled) return;
            if (sseRef.current) {
                try { sseRef.current.close(); } catch { /* noop */ }
                sseRef.current = null;
            }
            const es = new EventSource(`/api/room/${roomId}/sse?anonId=${anonId}`);
            sseRef.current = es;
            const upsertPolls = (incoming: PollClient | PollClient[]) => {
                setPolls((prev) => {
                    const map = new Map<string, PollClient>();
                    for (const p of prev) map.set(p._id, p);
                    const arr = Array.isArray(incoming) ? incoming : [incoming];
                    for (const p of arr) map.set(p._id, p);
                    return Array.from(map.values());
                });
            };
            es.addEventListener('snapshot', (ev: MessageEvent) => {
                const { payload } = JSON.parse(ev.data);
                setUsers(payload.users);
                setMessages(payload.messages);
                setOwner(payload.owner);
                setMyVotes(payload.myVotes || {});
                const unique = (payload.polls || []).reduce((acc: Record<string, PollClient>, p: PollClient) => { acc[p._id] = p; return acc; }, {});
                setPolls(Object.values(unique));
                if (typeof payload.pollsVersion === 'number') {
                    lastVersionRef.current = payload.pollsVersion;
                }
            });
            es.addEventListener('users', (ev: MessageEvent) => {
                const { payload } = JSON.parse(ev.data);
                setUsers(payload);
            });
            es.addEventListener('message', (ev: MessageEvent) => {
                const { payload } = JSON.parse(ev.data);
                setMessages((prev) => [...prev, payload]);
            });
            es.addEventListener('poll-created', (ev: MessageEvent) => {
                const { payload } = JSON.parse(ev.data);
                upsertPolls(payload);
            });
            // Instant delta event (minimal payload: _id, active)
            es.addEventListener('poll-updated', (ev: MessageEvent) => {
                const { payload } = JSON.parse(ev.data);
                if (!payload || Array.isArray(payload)) return;
                const { _id, active } = payload as { _id?: string; active?: boolean };
                if (!_id || typeof active !== 'boolean') return;
                setPolls(prev => prev.map(p => p._id === _id ? (p.active === active ? p : { ...p, active }) : p));
            });
            es.addEventListener('polls-replace', (ev: MessageEvent) => {
                const { payload } = JSON.parse(ev.data);
                // Support legacy array payload OR new { version, polls }
                if (Array.isArray(payload)) {
                    const unique = payload.reduce((acc: Record<string, PollClient>, p: PollClient) => { acc[p._id] = p; return acc; }, {});
                    setPolls(Object.values(unique));
                    return;
                }
                if (payload && Array.isArray(payload.polls)) {
                    const { version, polls: list } = payload as { version?: number; polls: PollClient[] };
                    if (typeof version === 'number') {
                        if (version <= lastVersionRef.current) return; // stale
                        lastVersionRef.current = version;
                    }
                    const unique = list.reduce((acc: Record<string, PollClient>, p: PollClient) => { acc[p._id] = p; return acc; }, {});
                    setPolls(Object.values(unique));
                }
            });
            es.addEventListener('poll-deleted', (ev: MessageEvent) => {
                const { payload } = JSON.parse(ev.data);
                setPolls((prev) => prev.filter((p) => p._id !== payload._id));
            });
            es.addEventListener('vote-cast', (ev: MessageEvent) => {
                const { payload } = JSON.parse(ev.data);
                if (payload?.poll) upsertPolls(payload.poll);
                if (payload?.anonId && payload?.pollId && payload?.optionId && payload.anonId === anonId) {
                    setMyVotes((prev) => ({ ...prev, [payload.pollId]: payload.optionId }));
                }
            });
            es.addEventListener('room-deleted', () => {
                router.replace("/?msg=Room closed");
            });

            // Periodic reconciliation: if no SSE activity for >15s or every 10s ensure poll list fresh
            // Removed periodic reconcile (now rely on authoritative full-list events). Keep a very light fallback every 60s.
            const fallback = async () => {
                if (cancelled) return;
                try {
                    const res = await fetch(`/api/room/${roomId}/poll`);
                    if (res.ok) {
                        const json = await res.json();
                        const list: PollClient[] = Array.isArray(json?.polls) ? json.polls : [];
                        if (list.length) setPolls(list);
                    }
                } catch { /* ignore */ }
            };
            reconcileInterval = setInterval(fallback, 60000);
        };
        joinAndSubscribe();
        return () => {
            cancelled = true;
            if (reconcileInterval) clearInterval(reconcileInterval);
            if (sseRef.current) {
                try { sseRef.current.close(); } catch { /* noop */ }
                sseRef.current = null;
            }
        };
    }, [roomId, anonId, router]);

    const sendMessage = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!content.trim()) return;
        setLoading(true);
        await fetch(`/api/room/${roomId}/message`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ anonId, content }),
        });
        setContent("");
        setLoading(false);
    };

    return (
        <div className="flex flex-col md:flex-row h-screen overflow-hidden bg-background transition-colors duration-500">
            <aside className="hidden md:flex w-full md:w-40 bg-card p-4 flex-col gap-2 border-r border-border shadow-lg animate-fade-in overflow-hidden">
                <div className="font-bold mb-4 text-lg flex items-start gap-2 flex-col text-foreground">
                    <div className="flex items-center gap-2">
                        <Users className="w-5 h-5" /> Users
                    </div>
                    <span className="text-sm font-normal text-muted-foreground">({dedupedUsers.length} connected)</span>
                </div>
                <div className="flex-1 min-h-0 flex-col gap-1 overflow-y-auto custom-scrollbar pr-1">
                    {dedupedUsers.map((u) => (
                        <div key={u.id} className={u.id === owner ? "font-bold text-primary flex items-center gap-1" : "flex items-center gap-1 text-foreground"}>
                            {u.id === owner ? <span title="Owner">👑</span> : null}
                            <span className="truncate text-muted-foreground">{u.id}</span>
                        </div>
                    ))}
                </div>
            </aside>
            <main className="flex-1 flex flex-col items-center animate-fade-in overflow-hidden w-full">
                <Card className="w-full flex flex-col flex-1 py-4 h-full max-h-full shadow-2xl border-border rounded-none bg-card gap-0">
                    <CardHeader>

                        <div className="flex items-center justify-between w-full">
                            <CardTitle className="text-xl flex items-center gap-2 text-foreground">
                                <MessageCircle className="w-5 h-5" /> Room: {roomId}
                            </CardTitle>
                            <Button asChild variant="secondary">
                                <Link href="/">Back Home</Link>
                            </Button>
                        </div>

                        <div className="font-bold md:mb-4 md:hidden text-lg flex items-center gap-2 text-foreground">
                            <Users className="w-5 h-5" /> Users
                            <span className="ml-2 text-sm font-normal text-muted-foreground">({dedupedUsers.length} connected)</span>
                        </div>

                    </CardHeader>
                    <CardContent className="flex flex-col px-4 flex-1 min-h-0 overflow-hidden">
                        <div className="space-y-4 my-2">
                            {owner === anonId ? (<CreatePoll roomId={roomId} anonId={anonId} />) : null}
                            {polls.map((p) => (
                                <PollCard
                                    key={p._id}
                                    poll={p}
                                    roomId={roomId}
                                    anonId={anonId as string}
                                    isOwner={owner === anonId}
                                    myVotes={myVotes}
                                    optimisticPatch={(pollId, patch) => {
                                        setPolls(prev => prev.map(pol => pol._id === pollId ? { ...pol, ...patch } : pol));
                                    }}
                                    optimisticRemove={(pollId) => {
                                        setPolls(prev => prev.filter(pol => pol._id !== pollId));
                                    }}
                                />
                            ))}
                        </div>
                        <div ref={messagesContainerRef} className="flex-1 min-h-0 overflow-y-auto space-y-2 mb-4 pr-2 custom-scrollbar">
                            {messages.map((m, i) => {
                                const isMine = m.userId === anonId;
                                const isLast = i === messages.length - 1;
                                return (
                                    <div
                                        key={m.id ?? i}
                                        className={
                                            "rounded p-2 shadow-sm border border-border max-w-[80%] " +
                                            (isMine ? "ml-auto bg-secondary" : "mr-auto bg-card") +
                                            (isLast ? " animate-fade-lite" : "")
                                        }
                                    >
                                        <span className="font-mono text-xs text-muted-foreground block mb-1">{m.userId}{m.userId === owner ? " 👑" : ""}</span>
                                        <div className="break-words whitespace-pre-wrap text-base">{m.content}</div>
                                    </div>
                                );
                            })}
                        </div>
                        <form onSubmit={sendMessage} className="flex gap-2 mt-auto pt-2 border-t border-border">
                            <Input className="flex-1 text-lg py-6" value={content} onChange={(e) => setContent(e.target.value)} placeholder="Type a message..." disabled={loading} required />
                            <Button type="submit" className="font-semibold text-lg py-6" disabled={loading}>
                                {loading ? <span className="animate-spin mr-2">⏳</span> : null}Send
                            </Button>
                        </form>
                    </CardContent>
                </Card>
            </main>
            <style jsx global>{`
        html { background: #0f0f0f; color-scheme: dark; }
        .custom-scrollbar::-webkit-scrollbar { width: 8px; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #444; border-radius: 4px; }
        .custom-scrollbar { scrollbar-width: thin; scrollbar-color: #444 transparent; }
        .animate-fade-lite { animation: fadeLite 220ms ease-out; }
        @keyframes fadeLite { from { opacity: 0; } to { opacity: 1; } }
      `}</style>
        </div>
    );
}

function CreatePoll({ roomId, anonId }: { roomId: string; anonId: string }) {
    const [open, setOpen] = useState(false);
    const [question, setQuestion] = useState("");
    const [opts, setOpts] = useState<string[]>(["", ""]);
    const [busy, setBusy] = useState(false);
    const addOpt = () => setOpts((o) => [...o, ""]);
    const updateOpt = (i: number, v: string) => setOpts((o) => o.map((x, idx) => (idx === i ? v : x)));
    const create = async (e: React.FormEvent) => {
        e.preventDefault();
        const options = opts.map((s) => s.trim()).filter(Boolean);
        if (!question.trim() || options.length < 2) return;
        setBusy(true);
        await fetch(`/api/room/${roomId}/poll`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ anonId, question, options }),
        });
        setQuestion("");
        setOpts(["", ""]);
        setBusy(false);
        setOpen(false);
    };
    return (
        <div className="bg-card rounded border border-border">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
                className="w-full flex items-center justify-between px-3 py-2 text-left text-sm font-semibold text-foreground hover:bg-accent/40 transition"
            >
                <span>Create poll</span>
                <ChevronDown className={"h-4 w-4 transition-transform " + (open ? "rotate-180" : "rotate-0")} />
            </button>
            {open ? (
                <form onSubmit={create} className="p-3 pt-0 space-y-2">
                    <Input className="" placeholder="Question" value={question} onChange={(e) => setQuestion(e.target.value)} disabled={busy} />
                    <div className="space-y-2">
                        {opts.map((o, i) => (
                            <Input key={i} className="" placeholder={`Option ${i + 1}`} value={o} onChange={(e) => updateOpt(i, e.target.value)} disabled={busy} />
                        ))}
                    </div>
                    <div className="flex gap-2 mt-2">
                        <Button type="button" onClick={addOpt} variant="secondary" disabled={busy}>Add option</Button>
                        <Button type="submit" disabled={busy}>Create</Button>
                    </div>
                </form>
            ) : null}
        </div>
    );
}

function PollCard({ poll, roomId, anonId, isOwner, myVotes, optimisticPatch, optimisticRemove }: { poll: PollClient; roomId: string; anonId: string; isOwner: boolean; myVotes: Record<string, string>; optimisticPatch: (pollId: string, patch: Partial<PollClient>) => void; optimisticRemove: (pollId: string) => void; }) {
    const [busy, setBusy] = useState(false);
    // Track last known active to allow rollback on fatal errors
    const lastActiveRef = useRef(poll.active);
    // Keep local active in sync with prop updates from SSE
    useEffect(() => { lastActiveRef.current = poll.active; }, [poll.active]);

    const vote = async (optionId: string) => {
        try {
            setBusy(true);
            const res = await fetch(`/api/room/${roomId}/poll/${poll._id}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ anonId, optionId }),
            });
            if (!res.ok) {
                try {
                    const err = await res.json();
                    console.error('Vote failed', res.status, err);
                    if (typeof window !== 'undefined') alert(`Vote failed (${res.status}): ${err?.errorCode || err?.error || 'Unknown error'}`);
                } catch {
                    console.error('Vote failed', res.status);
                }
            }
        } finally {
            setBusy(false);
        }
    };

    const toggle = async () => {
        const optimisticTarget = !poll.active;
        const previous = poll.active;
        optimisticPatch(poll._id, { active: optimisticTarget });
        try {
            setBusy(true);
            const res = await fetch(`/api/room/${roomId}/poll/${poll._id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ active: optimisticTarget, anonId }),
            });
            if (res.ok) {
                const data = await res.json().catch(() => null);
                if (data?.unchanged) {
                    // Backend reports no change; ensure local matches server (revert optimistic if needed)
                    if (previous !== poll.active) optimisticPatch(poll._id, { active: previous });
                }
            } else {
                let err: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
                try { err = await res.json(); } catch { /* ignore */ }
                const code = err?.errorCode;
                const benign = code === 'updateReturnedNull' || code === 'pollByIdOrRoomNotFound';
                if (!benign) {
                    // Fatal -> rollback
                    optimisticPatch(poll._id, { active: previous });
                    console.error('Toggle failed', res.status, err);
                    if (typeof window !== 'undefined') alert(`Toggle failed (${res.status}): ${code || err?.error || 'Unknown error'}`);
                }
            }
        } finally {
            setBusy(false);
        }
    };

    const del = async () => {
        const backup = poll; // capture for potential rollback
        optimisticRemove(poll._id);
        try {
            setBusy(true);
            const res = await fetch(`/api/room/${roomId}/poll/${poll._id}`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ anonId }),
            });
            if (!res.ok) {
                let err: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
                try { err = await res.json(); } catch { /* ignore */ }
                const code = err?.errorCode;
                const benign = code === 'pollByIdOrRoomNotFound' || code === 'deleteReturnedNull';
                if (!benign) {
                    // rollback if still absent
                    optimisticPatch(backup._id, backup);
                    console.error('Delete failed', res.status, err);
                    if (typeof window !== 'undefined') alert(`Delete failed (${res.status}): ${code || err?.error || 'Unknown error'}`);
                }
            } else {
                // If server responded with alreadyDeleted ok shape, nothing to do; SSE will not send event for alreadyDeleted
            }
        } finally {
            setBusy(false);
        }
    };

    const totalVotes = poll.options.reduce((sum, o) => sum + (o.votes || 0), 0) || 0;

    return (
        <div className="bg-card p-3 rounded border border-border">
            <div className="flex items-center justify-between">
                <div className="font-semibold text-foreground">{poll.question}</div>
                <div className="text-xs text-muted-foreground">{poll.active ? 'Open' : 'Closed'}</div>
            </div>
            <div className="mt-2 grid gap-2">
                {poll.options.map((o) => {
                    const selected = myVotes[poll._id] === o._id;
                    const pct = totalVotes > 0 ? Math.round((o.votes * 100) / totalVotes) : 0;
                    return (
                        <div key={o._id} className="relative overflow-hidden rounded border border-border">
                            <div className="absolute inset-0 pointer-events-none" aria-hidden>
                                <div className={(selected ? "bg-primary/40" : "bg-muted/40") + " h-full transition-all"} style={{ width: `${pct}%` }} />
                            </div>
                            <Button onClick={() => vote(o._id)} disabled={busy || !poll.active} variant="ghost" className={"relative z-10 w-full justify-between " + (selected ? "font-semibold" : "")}>
                                <span>{o.text}</span>
                                <span className="ml-4">{pct}% • {o.votes}</span>
                            </Button>
                        </div>
                    );
                })}
            </div>
            {isOwner ? (
                <div className="flex gap-2 mt-2">
                    <Button onClick={toggle} disabled={busy}>{poll.active ? 'Close' : 'Open'}</Button>
                    <Button onClick={del} disabled={busy} variant="destructive">Delete</Button>
                </div>
            ) : null}
        </div>
    );
}
