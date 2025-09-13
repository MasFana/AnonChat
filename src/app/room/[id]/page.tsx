import type { Metadata } from 'next';
import RoomClient from './roomClient';

// Await params (Next.js warning fix) – treat params as potentially async in newer versions.
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
    const { id } = await params;
    const safeId = (id || 'room').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'room';
    const title = `Room ${safeId} · Anon Chat`;
    const description = `Live anonymous chat room ${safeId}. Exchange real‑time messages and participate in polls.`;
    return {
        title,
        description,
        openGraph: { title, description, url: `/room/${safeId}`, type: 'article' },
        twitter: { title, description, card: 'summary' },
        alternates: { canonical: `/room/${safeId}` }
    };
}

export default async function RoomPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return <RoomClient roomId={id} />;
}
