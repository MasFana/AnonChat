import { NextResponse } from 'next/server';

// GET /api/anon -> generate a new anonymous user id (anon- + 10 lowercase alphanumerics)
export async function GET() {
  const id = 'anon-' + Array.from({ length: 10 }, () => {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    return chars[Math.floor(Math.random() * chars.length)];
  }).join('');
  return NextResponse.json({ anonId: id });
}
