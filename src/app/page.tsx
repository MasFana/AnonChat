
"use client";
import React, { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

function randomAnonId() {
  return (
    "anon-" + Math.random().toString(36).slice(2, 8)
  );
}

type RoomListItem = { id: string; createdAt: string; userCount: number; hasOwner: boolean };

export default function Home() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [roomId, setRoomId] = useState("");
  const [loading, setLoading] = useState(false);
  const [rooms, setRooms] = useState<RoomListItem[]>([]);
  const [roomsLoading, setRoomsLoading] = useState(false);
  const [msg, setMsg] = useState("");

  // Show message if redirected from closed room
  useEffect(() => {
    const urlMsg = searchParams.get("msg");
    if (urlMsg) setMsg(urlMsg);
  }, [searchParams]);

  // Ensure anonId in localStorage
  useEffect(() => {
    if (typeof window !== "undefined" && !localStorage.getItem("anonId")) {
      localStorage.setItem("anonId", randomAnonId());
    }
  }, []);

  const loadRooms = async () => {
    setRoomsLoading(true);
    try {
      const res = await fetch('/api/room');
      const data = await res.json();
      const list: RoomListItem[] = (Array.isArray(data.rooms) ? data.rooms : []).map((r: { id: string; createdAt: string | Date; userCount: number; hasOwner: boolean }) => ({
        id: r.id,
        createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date(r.createdAt).toISOString(),
        userCount: r.userCount,
        hasOwner: r.hasOwner,
      }));
      setRooms(list);
    } catch (e) {
      console.error('Failed to load rooms', e);
    } finally {
      setRoomsLoading(false);
    }
  };

  useEffect(() => {
    loadRooms();
    const t = setInterval(loadRooms, 10000);
    return () => clearInterval(t);
  }, []);


  const handleCreate = async () => {
    setLoading(true);
    const anonId = localStorage.getItem("anonId");
    const res = await fetch("/api/room", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ anonId }),
    });
    const data = await res.json();
    setLoading(false);
    if (data.roomId) {
      router.push(`/room/${data.roomId}`);
    }
  };

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const anonId = localStorage.getItem("anonId");
    const res = await fetch(`/api/room/${roomId}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ anonId }),
    });
    const data = await res.json();
    setLoading(false);
    if (data.joined) {
      router.push(`/room/${roomId}`);
    } else {
      setMsg(data.error || "Failed to join room");
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="max-w-6xl mx-auto px-4 py-8 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-primary/80 via-primary to-primary/60 shadow-[0_0_40px_rgba(59,130,246,0.35)]" />
          <div className="text-xl font-bold tracking-tight">Vibe Rooms</div>
        </div>
        <div className="hidden md:flex items-center gap-3">
          <Button onClick={handleCreate} disabled={loading}>
            {loading ? <span className="animate-spin mr-2">⏳</span> : null}Create Room
          </Button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 pb-16">
        {msg && <div className="mb-4 rounded bg-destructive/10 border border-destructive/40 px-3 py-2 text-destructive">{msg}</div>}

        <section className="grid md:grid-cols-3 gap-6 items-start">
          {/* Left: Create/Join Card */}
          <Card className="md:col-span-1 border border-border bg-card/80 backdrop-blur shadow-[0_10px_40px_rgba(0,0,0,0.4)]">
            <CardHeader>
              <CardTitle className="text-2xl">Start or Join</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <Button onClick={handleCreate} disabled={loading} className="w-full py-6 text-lg">
                {loading ? <span className="animate-spin mr-2">⏳</span> : null}Create a Room
              </Button>
              <form onSubmit={handleJoin} className="flex gap-2">
                <Input
                  placeholder="Enter Room ID"
                  value={roomId}
                  onChange={e => setRoomId(e.target.value)}
                  required
                  className="flex-1"
                  disabled={loading}
                />
                <Button type="submit" disabled={loading} variant="secondary">Join</Button>
              </form>
              <div className="text-xs text-muted-foreground border-t border-border pt-3">Anonymous by default. Your ID is stored locally.</div>
            </CardContent>
          </Card>

          {/* Right: Rooms list */}
          <div className="md:col-span-2">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xl font-semibold">Active Rooms</h2>
              <Button variant="secondary" onClick={loadRooms} disabled={roomsLoading}>
                {roomsLoading ? 'Refreshing…' : 'Refresh'}
              </Button>
            </div>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {roomsLoading && (
                <div className="col-span-full text-muted-foreground">Loading rooms…</div>
              )}
              {rooms.length === 0 && !roomsLoading && (
                <div className="col-span-full text-muted-foreground">No rooms yet. Create the first one!</div>
              )}
              {rooms.map((r) => (
                <button key={r.id} onClick={() => router.push(`/room/${r.id}`)} className="text-left group">
                  <div className="rounded-lg border border-border bg-card/70 p-4 hover:border-border/80 hover:bg-card transition-all shadow-[0_8px_30px_rgba(0,0,0,0.35)] hover:shadow-[0_12px_40px_rgba(0,0,0,0.5)]">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-semibold truncate">Room {r.id}</div>
                      <div className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5"><path d="M16 11c1.657 0 3-1.343 3-3s-1.343-3-3-3-3 1.343-3 3 1.343 3 3 3zm0 2c-2.21 0-4 1.79-4 4v1h8v-1c0-2.21-1.79-4-4-4zM8 13c1.657 0 3-1.343 3-3S9.657 7 8 7 5 8.343 5 10s1.343 3 3 3zm0 2c-2.21 0-4 1.79-4 4v1h6v-1c0-2.21-1.79-4-4-4z" /></svg>
                        {r.userCount}
                      </div>
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</div>
                    <div className="mt-3 text-xs">
                      <span className={"px-2 py-0.5 rounded-full border " + (r.hasOwner ? 'bg-emerald-900/30 text-emerald-300 border-emerald-800' : 'bg-amber-900/30 text-amber-300 border-amber-800')}>
                        {r.hasOwner ? 'Owner present' : 'Owner away'}
                      </span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="max-w-6xl mx-auto px-4 py-10 text-center text-muted-foreground text-sm">
        Built with Next.js · MongoDB · SSE
      </footer>

      <style jsx global>{`
        html { background: #0a0a0a; color-scheme: dark; }
        .animate-fade-in { animation: fadeIn 0.7s; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: none; } }
      `}</style>
    </div>
  );
}
