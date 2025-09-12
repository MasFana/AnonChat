
"use client";
import React, { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

function randomAnonId() {
  return (
    "anon-" + Math.random().toString(36).slice(2, 8)
  );
}

export default function Home() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [roomId, setRoomId] = useState("");
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");

  // Show message if redirected from closed room
  React.useEffect(() => {
    const urlMsg = searchParams.get("msg");
    if (urlMsg) setMsg(urlMsg);
  }, [searchParams]);

  // Ensure anonId in localStorage
  React.useEffect(() => {
    if (typeof window !== "undefined" && !localStorage.getItem("anonId")) {
      localStorage.setItem("anonId", randomAnonId());
    }
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
    <div className="flex flex-col items-center justify-center min-h-screen gap-8 p-4 bg-gradient-to-br from-gray-900 to-gray-950 transition-colors duration-500">
      <Card className="w-full max-w-md shadow-2xl border-0 bg-gray-900/95 backdrop-blur-md animate-fade-in">
        <CardHeader>
          <CardTitle className="text-3xl font-bold text-center tracking-tight text-white">Realtime Anonymous Chat</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {msg && <div className="text-red-400 text-center animate-pulse">{msg}</div>}
          <Button className="w-full font-semibold text-lg py-6 animate-fade-in bg-gray-800 text-white hover:bg-gray-700" onClick={handleCreate} disabled={loading}>
            {loading ? <span className="animate-spin mr-2">⏳</span> : null}Create Room
          </Button>
          <form onSubmit={handleJoin} className="flex flex-col gap-2 items-center animate-fade-in">
            <Input
              placeholder="Enter Room ID"
              value={roomId}
              onChange={e => setRoomId(e.target.value)}
              required
              className="w-full text-lg py-6 bg-gray-800 text-white border-gray-700 placeholder-gray-400"
              disabled={loading}
            />
            <Button type="submit" className="w-full font-semibold text-lg py-6 bg-gray-800 text-white hover:bg-gray-700" disabled={loading}>
              {loading ? <span className="animate-spin mr-2">⏳</span> : null}Join Room
            </Button>
          </form>
        </CardContent>
      </Card>
      <style jsx global>{`
        html { background: #0a0a0a; color-scheme: dark; }
        body { color: #fff; }
        .animate-fade-in { animation: fadeIn 0.7s; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: none; } }
      `}</style>
    </div>
  );
}
