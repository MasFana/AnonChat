"use client";
import React, { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

function randomAnonId() { return "anon-" + Math.random().toString(36).slice(2, 8); }

type RoomListItem = { id: string; createdAt: string; userCount: number; hasOwner: boolean };

export default function HomeClient({ initialMsg }: { initialMsg: string | null }) {
    const router = useRouter();
    const searchParams = useSearchParams();
    const [roomId, setRoomId] = useState("");
    const [loading, setLoading] = useState(false);
    const [rooms, setRooms] = useState<RoomListItem[]>([]);
    const [roomsLoading, setRoomsLoading] = useState(false);
    const [msg, setMsg] = useState(initialMsg || "");

    useEffect(() => {
        const urlMsg = searchParams.get("msg");
        if (urlMsg) setMsg(urlMsg);
    }, [searchParams]);

    useEffect(() => { if (typeof window !== "undefined" && !localStorage.getItem("anonId")) localStorage.setItem("anonId", randomAnonId()); }, []);

    const loadRooms = async () => {
        setRoomsLoading(true);
        try {
            const res = await fetch('/api/room'); const data = await res.json();
            const list: RoomListItem[] = (Array.isArray(data.rooms) ? data.rooms : []).map((r: { id: string; createdAt: string | Date; userCount: number; hasOwner: boolean }) => ({
                id: r.id,
                createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date(r.createdAt).toISOString(),
                userCount: r.userCount,
                hasOwner: r.hasOwner,
            }));
            setRooms(list);
        } catch (e) { console.error('Failed to load rooms', e); } finally { setRoomsLoading(false); }
    };
    useEffect(() => { loadRooms(); const t = setInterval(loadRooms, 10000); return () => clearInterval(t); }, []);

    const handleCreate = async () => {
        setLoading(true); const anonId = localStorage.getItem("anonId");
        const res = await fetch("/api/room", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ anonId }) });
        const data = await res.json(); setLoading(false); if (data.roomId) router.push(`/room/${data.roomId}`);
    };

    const handleJoin = async (e: React.FormEvent) => {
        e.preventDefault(); const trimmed = roomId.trim(); if (trimmed.length < 3) return; setLoading(true);
        const anonId = localStorage.getItem("anonId");
        const res = await fetch(`/api/room/${trimmed}/join`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ anonId }) });
        const data = await res.json(); setLoading(false);
        if (data.joined) router.push(`/room/${trimmed}`); else setMsg(data.error || "Failed to join room");
    };

    return (
        <div className="min-h-screen bg-gradient-to-b from-neutral-900 to-neutral-950 text-foreground flex flex-col justify-between">
            <div>
                <header className="max-w-6xl mx-auto px-4 py-8 flex items-center justify-between">
                    <div className="flex items-center">
                        <div className="flex items-center justify-end">
                            <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24"><path fill="#ededed" fillRule="evenodd" d="M21 11.901V6.43c0-2.269 0-3.404-.707-4.024c-.707-.621-1.788-.434-3.95-.061l-1.055.182c-1.64.283-2.46.425-3.288.425c-.828 0-1.648-.142-3.288-.425l-1.054-.182c-2.162-.373-3.244-.56-3.95.06C3 3.026 3 4.16 3 6.43v5.472c0 5.69 4.239 8.45 6.899 9.622c.721.318 1.082.477 2.101.477c1.02 0 1.38-.159 2.101-.477C16.761 20.351 21 17.59 21 11.901ZM7.17 9.141c.124-.257.587-.607 1.33-.607c.743 0 1.206.35 1.33.606a.738.738 0 0 0 1.005.348a.79.79 0 0 0 .336-1.043C10.712 7.494 9.603 6.98 8.5 6.98c-1.103 0-2.212.515-2.67 1.466a.79.79 0 0 0 .335 1.043a.738.738 0 0 0 1.006-.348Zm8.33-.607c-.743 0-1.206.35-1.33.606a.738.738 0 0 1-1.005.348a.79.79 0 0 1-.336-1.043c.459-.951 1.567-1.466 2.671-1.466c1.104 0 2.212.515 2.67 1.466a.79.79 0 0 1-.335 1.043a.738.738 0 0 1-1.006-.348c-.123-.256-.586-.606-1.329-.606Zm-7.511 6.008a.804.804 0 0 1-.032-1.104a.748.748 0 0 1 1.067-.022l.102.079c.101.071.268.176.507.285c.475.216 1.247.453 2.367.453c1.12 0 1.892-.237 2.367-.453c.239-.109.406-.214.506-.285a1.523 1.523 0 0 0 .117-.091l.001-.001a.731.731 0 0 1 1.052.035a.797.797 0 0 1-.026 1.098l-.001.002h-.001l-.003.004l-.008.007l-.02.019a3.027 3.027 0 0 1-.262.209a4.57 4.57 0 0 1-.751.426c-.663.302-1.64.584-2.971.584c-1.33 0-2.308-.282-2.97-.584a4.569 4.569 0 0 1-.752-.427a3.018 3.018 0 0 1-.288-.233l-.001-.001Z" clipRule="evenodd" /></svg>
                        </div>
                        <div className="text-xl font-bold tracking-tight">Anon Chat</div>
                    </div>
                    <div className="hidden md:flex items-center gap-3">
                        <Button onClick={handleCreate} disabled={loading}>{loading ? <span className="animate-spin mr-2">⏳</span> : null}Create Room</Button>
                    </div>
                </header>
                <main className="relative">
                    <div className="pointer-events-none absolute inset-0 -z-10 opacity-60 [background:radial-gradient(circle_at_30%_20%,#3b82f622,transparent_60%),radial-gradient(circle_at_70%_40%,#6366f122,transparent_65%),radial-gradient(circle_at_50%_80%,#06b6d422,transparent_70%)]" />
                    <section className="max-w-6xl mx-auto px-4 pt-4 pb-12 md:pb-20">
                        <div aria-live="polite" className="min-h-[0]">{msg && <div className="mb-6 rounded bg-destructive/10 border border-destructive/40 px-3 py-2 text-destructive animate-fade-in" role="alert">{msg}</div>}</div>
                        <div className="max-w-3xl mx-auto space-y-8 text-center">
                            <div className="space-y-6">
                                <h1 className="text-4xl sm:text-5xl font-extrabold leading-tight tracking-tight">Real‑time Anonymous Chat <span className="block bg-gradient-to-r from-cyan-300 via-sky-400 to-indigo-400 bg-clip-text text-transparent">with Live Polls</span></h1>
                                <p className="text-lg text-muted-foreground max-w-2xl mx-auto">Spin up a room instantly. Chat live, launch quick polls, then disappear no accounts, no history.</p>
                                <div className="space-y-4">
                                    <div className="mx-auto flex flex-col gap-4 sm:gap-3 sm:flex-row sm:items-stretch max-w-2xl">
                                        <Button onClick={handleCreate} disabled={loading} className="relative h-14 px-7 text-lg font-semibold shadow-lg shadow-cyan-500/10 flex-1 sm:flex-none sm:w-auto overflow-hidden group">
                                            <span className="absolute inset-0 opacity-0 group-hover:opacity-100 transition bg-gradient-to-r from-cyan-500/20 to-indigo-500/20" />
                                            {loading ? <span className="animate-spin mr-2">⏳</span> : null}Create Room
                                        </Button>
                                        <div className="hidden sm:flex items-center px-2 text-xs uppercase tracking-wide text-neutral-500 select-none">or</div>
                                        <form onSubmit={handleJoin} className="flex-1 flex gap-2" aria-label="Join existing room">
                                            <div className="relative flex-1">
                                                <Input placeholder="Enter Room ID" value={roomId} onChange={e => setRoomId(e.target.value)} required inputMode="text" pattern="[A-Za-z0-9_-]{3,}" title="Room ID must be at least 3 characters (letters, numbers, dash, underscore)." className="peer flex-1 h-14 text-base pr-10" disabled={loading} aria-label="Room ID" autoComplete="off" />
                                                {roomId && (<button type="button" onClick={() => setRoomId("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-300 text-xs px-2 py-1 rounded" aria-label="Clear room id">✕</button>)}
                                            </div>
                                            <Button type="submit" disabled={loading || roomId.trim().length < 3} variant="secondary" className="h-14 px-6 font-medium">Join</Button>
                                        </form>
                                    </div>
                                    <div className="sm:hidden flex items-center gap-3 text-[10px] uppercase tracking-wider text-neutral-500"><div className="flex-1 h-px bg-neutral-800" />or<div className="flex-1 h-px bg-neutral-800" /></div>
                                </div>
                                <div className="text-xs text-muted-foreground">Anonymous ID lives only in this browser. Refresh to regenerate.</div>
                            </div>
                            <HeroStats rooms={rooms} />
                        </div>
                    </section>
                    <section className="max-w-6xl mx-auto px-4 pb-24" aria-labelledby="rooms-heading">
                        <div className="flex items-center justify-between mb-4">
                            <h2 id="rooms-heading" className="text-2xl font-semibold tracking-tight">Active Rooms</h2>
                            <Button variant="secondary" onClick={loadRooms} disabled={roomsLoading} className="hover:shadow">{roomsLoading ? 'Refreshing…' : 'Refresh'}</Button>
                        </div>
                        <div className="grid sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-5">
                            {rooms.map((r) => (
                                <button key={r.id} onClick={() => router.push(`/room/${r.id}`)} className="text-left group">
                                    <div className="rounded-xl border border-border/60 bg-card/70 p-4 hover:border-border/90 hover:bg-card transition-all shadow-[0_5px_25px_-5px_rgba(0,0,0,0.5)] hover:shadow-[0_10px_35px_-5px_rgba(0,0,0,0.6)]">
                                        <div className="flex items-center justify-between gap-2">
                                            <div className="font-medium truncate">Room {r.id}</div>
                                            <div className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground">
                                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3"><path d="M16 11c1.657 0 3-1.343 3-3s-1.343-3-3-3-3 1.343-3 3 1.343 3 3 3zm0 2c-2.21 0-4 1.79-4 4v1h8v-1c0-2.21-1.79-4-4-4zM8 13c1.657 0 3-1.343 3-3S9.657 7 8 7 5 8.343 5 10s1.343 3 3 3zm0 2c-2.21 0-4 1.79-4 4v1h6v-1c0-2.21-1.79-4-4-4z" /></svg>
                                                {r.userCount}
                                            </div>
                                        </div>
                                        <div className="mt-2 text-[11px] text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</div>
                                        <div className="mt-3 text-[11px]"><span className={"px-2 py-0.5 rounded-full border " + (r.hasOwner ? 'bg-emerald-900/30 text-emerald-300 border-emerald-800' : 'bg-amber-900/30 text-amber-300 border-amber-800')}>{r.hasOwner ? 'Owner present' : 'Owner away'}</span></div>
                                    </div>
                                </button>
                            ))}
                            {roomsLoading && (<div className="col-span-full text-center text-muted-foreground">Loading rooms…</div>)}
                            {rooms.length === 0 && !roomsLoading && (<div className="col-span-full text-center muted-foreground">No rooms yet. Be the first to create one above.</div>)}
                        </div>
                    </section>
                </main>
            </div>
            <style jsx global>{`html { background: #1b1b1b; color-scheme: dark; } .animate-fade-in { animation: fadeIn 0.7s; } @keyframes fadeIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: none; } }`}</style>
            <footer className="max-w-6xl mx-auto px-4 py-10 text-center text-muted-foreground text-sm">Built with Next.js · MongoDB · SSE ❤️ <a href="https://github.com/MasFana" className="underline hover:text-foreground">MasFana</a></footer>
        </div>
    );
}

function HeroStats({ rooms }: { rooms: RoomListItem[] }) {
    const totalUsers = rooms.reduce((a, r) => a + (r.userCount || 0), 0);
    return (
        <div className="flex flex-wrap justify-center gap-4 pt-6">
            <Stat number={rooms.length} label="Active Rooms" />
            <Stat number={totalUsers} label="Participants" />
            <Stat number={rooms.filter(r => r.hasOwner).length} label="Owners Online" />
        </div>
    );
}
function Stat({ number, label }: { number: number; label: string }) {
    return (
        <div className="min-w-[110px] px-4 py-2 rounded-lg border border-border/60 bg-neutral-900/40 backdrop-blur text-center">
            <div className="text-xl font-semibold tabular-nums bg-gradient-to-r from-cyan-300 to-indigo-300 bg-clip-text text-transparent">{number}</div>
            <div className="mt-0.5 text-[11px] tracking-wide uppercase text-neutral-400">{label}</div>
        </div>
    );
}
