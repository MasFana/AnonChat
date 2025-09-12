"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Users, MessageCircle } from "lucide-react";

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
export default function RoomPage({ params }: { params: Promise<{ id: string }> }) {
    const router = useRouter();
    // const searchParams = useSearchParams();
    const [users, setUsers] = useState<User[]>([]);
    const [messages, setMessages] = useState<Message[]>([]);
    const [owner, setOwner] = useState<string>("");
    const [content, setContent] = useState("");
    const [loading, setLoading] = useState(false);
    const pollingRef = useRef<NodeJS.Timeout | null>(null);
    // Unwrap params using React.use()
    const { id: roomId } = React.use(params);
    const anonId = typeof window !== "undefined" ? localStorage.getItem("anonId") : null;

    // Join room if not already joined, then start polling
    useEffect(() => {
        if (!anonId) {
            router.replace("/?msg=missing-id");
            return;
        }
        // Join the room (idempotent)
        const joinRoom = async () => {
            await fetch(`/api/room/${roomId}/join`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ anonId }),
            });
        };
        joinRoom().then(() => {
            const poll = async () => {
                const res = await fetch(`/api/room/${roomId}/state?anonId=${anonId}`);
                const data = await res.json();
                if (data.deleted) {
                    router.replace("/?msg=Room closed");
                    return;
                }
                setUsers(data.users);
                setMessages(data.messages);
                setOwner(data.owner);
            };
            poll();
            pollingRef.current = setInterval(poll, 2000);
        });
        return () => {
            if (pollingRef.current) clearInterval(pollingRef.current);
        };
    }, [roomId, anonId, router]);

    // Send message
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
        <div className="flex flex-col md:flex-row h-full min-h-screen bg-gradient-to-br from-gray-900 to-gray-950 transition-colors duration-500">
            <aside className=" hidden md:flex w-full md:w-48 bg-gray-900/95 p-4 flex-col gap-2 border-r border-gray-800 shadow-lg animate-fade-in">
                <div className="font-bold mb-4 text-lg flex items-start gap-2 flex-col text-white">
                    <div className="flex items-center gap-2">
                        <Users className="w-5 h-5" /> Users
                    </div>
                    <span className="text-sm font-normal text-gray-400">({users.length} connected)</span>
                </div>
                <div className="flex-col gap-1 overflow-y-auto">
                    {users.map((u) => (
                        <div key={u.id} className={u.id === owner ? "font-bold text-primary flex items-center gap-1" : "flex items-center gap-1 text-gray-200"}>
                            {u.id === owner ? <span title="Owner">👑</span> : null}
                            <span className="truncate text-gray-400">{u.id}</span>
                        </div>
                    ))}
                </div>
            </aside>
            <main className="flex-1 flex flex-col items-center justify-center animate-fade-in">

                <Card className="w-full max-w-2xl flex flex-col flex-1 h-[80vh] shadow-2xl border-0 bg-gray-900/95 backdrop-blur-md">
                    <CardHeader>
                        <CardTitle className="text-xl flex items-center gap-2 text-white"><MessageCircle className="w-5 h-5" /> Room: {roomId}</CardTitle>
                        <div className="font-bold md:mb-4 md:hidden text-lg flex items-center gap-2 text-white">
                            <Users className="w-5 h-5" /> Users
                            <span className="ml-2 text-sm font-normal text-gray-400">({users.length} connected)</span>
                        </div>
                    </CardHeader>
                    <CardContent className="flex flex-col flex-1 h-0">
                        <div className="flex-1 overflow-y-auto space-y-2 mb-4 pr-2 custom-scrollbar">
                            {messages.map((m, i) => (
                                <div key={i} className={
                                    "rounded p-2 shadow-sm transition-all " +
                                    (m.userId === anonId
                                        ? "bg-gray-800 text-white ml-auto max-w-[80%] animate-fade-in border border-gray-700"
                                        : "bg-gray-900 text-gray-200 mr-auto max-w-[80%] animate-fade-in border border-gray-800")
                                }>
                                    <span className="font-mono text-xs text-gray-400 block mb-1">{m.userId}{m.userId === owner ? " 👑" : ""}</span>
                                    <div className="break-words whitespace-pre-wrap text-base">{m.content}</div>
                                </div>
                            ))}
                        </div>
                        <form onSubmit={sendMessage} className="flex gap-2 mt-auto animate-fade-in">
                            <Input
                                className="flex-1 text-lg py-6 bg-gray-800 text-white border-gray-700 placeholder-gray-400"
                                value={content}
                                onChange={(e) => setContent(e.target.value)}
                                placeholder="Type a message..."
                                disabled={loading}
                                required
                            />
                            <Button type="submit" className="font-semibold text-lg py-6 bg-gray-800 text-white hover:bg-gray-700" disabled={loading}>
                                {loading ? <span className="animate-spin mr-2">⏳</span> : null}Send
                            </Button>
                        </form>
                    </CardContent>
                </Card>
            </main>
            <style jsx global>{`
        html { background: #0a0a0a; color-scheme: dark; }
        body { color: #fff; }
        .custom-scrollbar::-webkit-scrollbar { width: 8px; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #444; border-radius: 4px; }
        .custom-scrollbar { scrollbar-width: thin; scrollbar-color: #444 transparent; }
        .animate-fade-in { animation: fadeIn 0.7s; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: none; } }
      `}</style>
        </div>
    );
}
