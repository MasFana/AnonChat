import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';

// GET /api/anon -> generate a new anonymous user id (anon- + 10 lowercase alphanumerics)
export async function GET() {
  // Prefer crypto.randomUUID if available for quick strong randomness, else fallback to randomBytes -> base36 slice
  let core: string;
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    core = (crypto as unknown as { randomUUID: () => string }).randomUUID().replace(/-/g, '').slice(0, 12);
  } else {
    core = randomBytes(8).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
  }
  // Normalize to lowercase and restrict to [a-z0-9]
  core = core.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (core.length < 10) {
    // Pad using additional random bytes if necessary
    core += randomBytes(6).toString('hex').slice(0, 10 - core.length);
  }
  const id = 'anon-' + core.slice(0, 10);
  return NextResponse.json({ anonId: id });
}
