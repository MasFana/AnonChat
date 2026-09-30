"use client";

import { useEffect, useState } from "react";
import RoomClient from "@/components/RoomClient";

export default function RoomRouteClient() {
    const [roomId, setRoomId] = useState("");
    const [invalid, setInvalid] = useState(false);
    useEffect(() => {
        const match = /^\/room\/([^/]+)\/?$/.exec(window.location.pathname);
        if (!match) { setInvalid(true); return; }
        try {
            setRoomId(decodeURIComponent(match[1]));
        } catch {
            setInvalid(true);
        }
    }, []);
    if (invalid) {
        return (
            <main className="min-h-screen flex items-center justify-center bg-background text-foreground p-6">
                <p role="alert" className="text-sm text-amber-300">Invalid room link. Check the URL and try again.</p>
            </main>
        );
    }
    return roomId ? <RoomClient roomId={roomId} /> : null;
}