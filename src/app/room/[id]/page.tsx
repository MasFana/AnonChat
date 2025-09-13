import type { Metadata } from 'next';
import RoomClient from './roomClient';

export async function generateMetadata({ params }: { params: { id: string } }): Promise<Metadata> {
    const { id } = params;
    const title = `Room ${id} · Anon Chat`;
    const description = `Live anonymous chat room ${id}. Exchange real‑time messages and participate in polls.`;
    return {
        title,
        description,
        openGraph: { title, description, url: `/room/${id}`, type: 'article' },
        twitter: { title, description, card: 'summary' },
        alternates: { canonical: `/room/${id}` }
    };
}

export default function RoomPage({ params }: { params: { id: string } }) {
    return <RoomClient roomId={params.id} />;
}
