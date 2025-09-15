"use client";
import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Users, MessageCircle, ChevronDown, Bell, BellOff } from 'lucide-react';
import Link from 'next/link';

async function getOrCreateAnonId(): Promise<string | null> {
  if (typeof window === 'undefined') return null;
  const id = localStorage.getItem('anonId');
  if (id && /^anon-[a-z0-9]{10}$/i.test(id)) return id;
  try {
    const res = await fetch('/api/anon', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json().catch(() => null) as { anonId?: string } | null;
      if (data?.anonId && /^anon-[a-z0-9]{10}$/i.test(data.anonId)) {
        localStorage.setItem('anonId', data.anonId);
        return data.anonId;
      }
    }
  } catch { /* ignore */ }
  return null;
}

interface User { id: string; roomId: string; lastSeen: string; connectedAt: string }
interface Message { id?: string; roomId: string; userId: string; content: string; createdAt: string }
interface PollOptionClient { _id: string; text: string; votes: number }
interface PollClient { _id: string; roomId: string; question: string; options: PollOptionClient[]; active: boolean; createdAt: string; updatedAt: string }

export default function RoomClient({ roomId }: { roomId: string }) {
  const router = useRouter();
  const [users, setUsers] = useState<User[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [owner, setOwner] = useState<string>('');
  const [polls, setPolls] = useState<PollClient[]>([]);
  const [isPublic, setIsPublic] = useState(false);
  const pendingVisibilityRef = useRef<null | boolean>(null); // track an in-flight optimistic toggle
  const [visibilityBusy, setVisibilityBusy] = useState(false);
  const [metaLoading, setMetaLoading] = useState(true);
  const lastVersionRef = useRef(0);
  const [content, setContent] = useState('');
  const [myVotes, setMyVotes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const sseRef = useRef<EventSource | null>(null);
  const terminatedRef = useRef(false); // set when room-deleted so we do not recreate SSE
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  // Start with null universally (SSR + first client render) to avoid hydration mismatch.
  // We'll populate anonId after mount.
  const [anonId, setAnonId] = useState<string | null>(null);
  // Notification toggle state
  const [notifyEnabled, setNotifyEnabled] = useState<boolean>(false);
  // Keep latest values in refs for event listeners (avoid stale closure without re-adding listeners)
  const anonIdRef = useRef<string | null>(null);
  const notifyEnabledRef = useRef<boolean>(false);
  const lastNotifiedMessageIdRef = useRef<string | undefined>(undefined);

  // Load persisted notification preference
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = localStorage.getItem('roomNotifyEnabled');
    if (stored === '1') setNotifyEnabled(true);
  }, []);

  // Sync values into refs for SSE handlers
  useEffect(() => { anonIdRef.current = anonId; }, [anonId]);
  useEffect(() => { notifyEnabledRef.current = notifyEnabled; }, [notifyEnabled]);

  const dedupedUsers = React.useMemo(() => {
    const seen = new Set<string>();
    const list: User[] = [];
    for (const u of users) { if (!seen.has(u.id)) { seen.add(u.id); list.push(u); } }
    return list;
  }, [users]);

  useEffect(() => {
    const el = messagesContainerRef.current; if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    let mounted = true;
    const ensureIdAndStart = async () => {
      let id = anonId;
      if (!id) {
        id = await getOrCreateAnonId();
        if (mounted && id) setAnonId(id);
      }
      if (!id) return; // cannot proceed without id (very unlikely)
      let cancelled = false; let reconcileInterval: NodeJS.Timeout | null = null;
      const loadMetaAndConnect = async () => {
        try {
          // 1. Fetch lightweight meta first
          const metaRes = await fetch(`/api/room/${roomId}/meta`, { cache: 'no-store' });
          if (!metaRes.ok) {
            if (metaRes.status === 404) { router.replace('/?msg=Room%20not%20found'); return; }
          } else {
            const meta = await metaRes.json().catch(() => null);
            if (meta && meta.ownerId) setOwner(meta.ownerId);
            if (meta && typeof meta.isPublic === 'boolean') setIsPublic(meta.isPublic);
          }
        } finally {
          setMetaLoading(false);
        }
        if (cancelled) return;
        // 2. Join (presence)
        try {
          const res = await fetch(`/api/room/${roomId}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ anonId: id }) });
          if (res.ok) {
            const data = await res.json().catch(() => null);
            if (data && typeof data.ownerId === 'string') setOwner(data.ownerId);
          }
        } catch { }
        if (cancelled) return;
        if (sseRef.current) { try { sseRef.current.close(); } catch { } sseRef.current = null; }
        if (terminatedRef.current) return; // do not reconnect after termination
        const es = new EventSource(`/api/room/${roomId}/sse?anonId=${id}`); sseRef.current = es;
        const upsertPolls = (incoming: PollClient | PollClient[]) => {
          setPolls(prev => {
            const map = new Map<string, PollClient>(); prev.forEach(p => map.set(p._id, p));
            const arr = Array.isArray(incoming) ? incoming : [incoming];
            arr.forEach(p => map.set(p._id, p));
            return Array.from(map.values());
          });
        };
        es.addEventListener('snapshot', (ev: MessageEvent) => {
          const { payload } = JSON.parse(ev.data);
          setUsers(payload.users); setMessages(payload.messages); setOwner(payload.owner); setMyVotes(payload.myVotes || {});
          // If we have an optimistic pending visibility change, prefer that until an explicit room-visibility event arrives
          if (pendingVisibilityRef.current === null) {
            setIsPublic(!!payload.isPublic);
          }
          const unique = (payload.polls || []).reduce((acc: Record<string, PollClient>, p: PollClient) => { acc[p._id] = p; return acc; }, {});
          setPolls(Object.values(unique));
          if (typeof payload.pollsVersion === 'number') lastVersionRef.current = payload.pollsVersion;
        });
        es.addEventListener('room-visibility', (ev: MessageEvent) => { try { const { payload } = JSON.parse(ev.data); if (payload?.roomId === roomId && typeof payload.isPublic === 'boolean') { setIsPublic(payload.isPublic); pendingVisibilityRef.current = null; setVisibilityBusy(false); } } catch { } });
        es.addEventListener('users', (ev: MessageEvent) => { const { payload } = JSON.parse(ev.data); setUsers(payload); });
        es.addEventListener('message', (ev: MessageEvent) => {
          const { payload } = JSON.parse(ev.data);
          setMessages(prev => [...prev, payload]);
          try {
            if (!payload) return;
            // Only attempt if enabled and browser supports Notification API
            if (!notifyEnabledRef.current || typeof Notification === 'undefined') return;
            if (Notification.permission !== 'granted') return;
            const me = anonIdRef.current;
            if (me && payload.userId === me) return; // ignore own messages
            const msgId = payload.id || payload.createdAt;
            if (msgId && lastNotifiedMessageIdRef.current === msgId) return; // de-dupe
            if (msgId) lastNotifiedMessageIdRef.current = msgId;
            const n = new Notification((payload.content || '').slice(0, 160) || 'New message', {
              tag: msgId || `${roomId}-latest`, // tag collapses duplicates
            });

            const closeTimer = setTimeout(() => {
              try { n.close(); } catch { /* ignore */ }
            }, 5000);

            n.onclick = () => {
              try { window.focus(); } catch { /* ignore */ }
              try { clearTimeout(closeTimer); } catch { /* ignore */ }
            };
          } catch { /* swallow notification errors */ }
        });
        es.addEventListener('poll-created', (ev: MessageEvent) => { const { payload } = JSON.parse(ev.data); upsertPolls(payload); });
        es.addEventListener('poll-updated', (ev: MessageEvent) => {
          const { payload } = JSON.parse(ev.data); if (!payload || Array.isArray(payload)) return;
          const { _id, active } = payload as { _id?: string; active?: boolean }; if (!_id || typeof active !== 'boolean') return;
          setPolls(prev => prev.map(p => p._id === _id ? (p.active === active ? p : { ...p, active }) : p));
        });
        es.addEventListener('polls-replace', (ev: MessageEvent) => {
          const { payload } = JSON.parse(ev.data);
          if (Array.isArray(payload)) { const unique = payload.reduce((acc: Record<string, PollClient>, p: PollClient) => { acc[p._id] = p; return acc; }, {}); setPolls(Object.values(unique)); return; }
          if (payload && Array.isArray(payload.polls)) {
            const { version, polls: list } = payload as { version?: number; polls: PollClient[] };
            if (typeof version === 'number') { if (version <= lastVersionRef.current) return; lastVersionRef.current = version; }
            const unique = list.reduce((acc: Record<string, PollClient>, p: PollClient) => { acc[p._id] = p; return acc; }, {}); setPolls(Object.values(unique));
          }
        });
        es.addEventListener('poll-deleted', (ev: MessageEvent) => { const { payload } = JSON.parse(ev.data); setPolls(prev => prev.filter(p => p._id !== payload._id)); });
        es.addEventListener('vote-cast', (ev: MessageEvent) => {
          const { payload } = JSON.parse(ev.data);
          if (payload?.poll) upsertPolls(payload.poll);
          if (payload?.anonId && payload?.pollId && payload?.optionId && payload.anonId === id) setMyVotes(prev => ({ ...prev, [payload.pollId]: payload.optionId }));
        });
        es.addEventListener('room-deleted', () => {
          terminatedRef.current = true;
          try { es.close(); } catch { }
          sseRef.current = null;
          router.replace('/?msg=Room+Closed');
        });
        reconcileInterval = setInterval(async () => {
          if (cancelled) return; try { const res = await fetch(`/api/room/${roomId}/poll`); if (res.ok) { const json = await res.json(); const list: PollClient[] = Array.isArray(json?.polls) ? json.polls : []; if (list.length) setPolls(list); } } catch { }
        }, 60000);
      };
      loadMetaAndConnect();
      return () => { cancelled = true; if (reconcileInterval) clearInterval(reconcileInterval); if (sseRef.current) { try { sseRef.current.close(); } catch { } sseRef.current = null; } };
    };
    ensureIdAndStart();
    return () => { mounted = false; };
    // We intentionally exclude anonId so that establishing the SSE connection
    // happens only once per room mount; anonId is resolved inside the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, router]);

  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault(); if (!content.trim() || !anonId) return; setLoading(true);
    await fetch(`/api/room/${roomId}/message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ anonId, content }) });
    setContent(''); setLoading(false);
  };

  return (
    <div className="flex flex-col md:flex-row h-screen overflow-hidden bg-background transition-colors duration-500">
      <aside className="hidden md:flex w-full md:w-40 bg-card p-4 flex-col gap-2 border-r border-border shadow-lg animate-fade-in overflow-hidden">
        <div className="font-bold mb-4 text-lg flex items-start gap-2 flex-col text-foreground">
          <div className="flex items-center gap-2"><Users className="w-5 h-5" /> Users</div>
          <span className="text-sm font-normal text-muted-foreground">({dedupedUsers.length} connected)</span>
        </div>
        <div className="flex-1 min-h-0 flex-col gap-1 overflow-y-auto custom-scrollbar pr-1">
          {dedupedUsers.map(u => (
            <div key={u.id} className={u.id === owner ? 'font-bold text-primary flex items-center gap-1' : 'flex items-center gap-1 text-foreground'}>
              {u.id === owner ? <span title="Owner">👑</span> : null}
              <span className="truncate text-muted-foreground">{u.id}</span>
            </div>
          ))}
        </div>
      </aside>
      <main className="flex-1 flex flex-col items-center animate-fade-in overflow-hidden w-full">
        <Card className="w-full flex flex-col flex-1 py-4 h-full max-h-full shadow-2xl border-border rounded-none bg-card gap-0">
          <CardHeader className="px-4">
            <div className="w-full flex flex-col gap-2">
              <div className="flex items-center gap-2 w-full">
                <CardTitle className="flex items-center gap-2 text-foreground text-base sm:text-lg md:text-xl min-w-0 flex-1">
                  <MessageCircle className="w-5 h-5 shrink-0" />
                  <span className="hidden sm:inline shrink-0">Room:</span>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(roomId);
                        const btn = document.getElementById('room-id-copy');
                        if (btn) { btn.dataset.copied = 'true'; setTimeout(() => { delete btn.dataset.copied; }, 1600); }
                      } catch { }
                    }}
                    id="room-id-copy"
                    className="relative group font-mono px-2 py-1 rounded hover:bg-accent/40 border border-transparent hover:border-accent/40 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 max-w-[40vw] sm:max-w-[320px] md:max-w-[420px] overflow-hidden"
                    title="Click to copy room ID"
                  >
                    <span className="select-all block truncate" data-hide-when-overflow="true">{roomId}</span>
                    <span className="pointer-events-none absolute top-0 right-0 -translate-y-full mt-[-2px] opacity-0 group-data-[copied=true]:opacity-100 group-data-[copied=true]:translate-y-0 text-[10px] tracking-wide text-emerald-300 transition-all duration-300">Copied!</span>
                  </button>
                </CardTitle>
                <div className="flex items-center gap-2 shrink-0">
                  {/* Notification toggle */}
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        if (!notifyEnabled) {
                          // turning on
                          if (typeof Notification !== 'undefined') {
                            if (Notification.permission === 'default') {
                              const perm = await Notification.requestPermission();
                              if (perm !== 'granted') return; // abort enable
                            } else if (Notification.permission !== 'granted') {
                              return; // can't enable
                            }
                          } else { return; }
                        }
                        setNotifyEnabled(v => {
                          const next = !v; localStorage.setItem('roomNotifyEnabled', next ? '1' : '0');
                          if (next && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
                            try {
                              new Notification('Notifications enabled', { body: 'You will be alerted for new messages.' });
                            } catch { /* ignore */ }
                          }
                          return next;
                        });
                      } catch { }
                    }}
                    className={'relative flex items-center gap-1 px-2 py-1 rounded border text-[11px] font-medium transition ' + (notifyEnabled ? 'bg-primary/20 border-primary/40 text-primary-foreground/90 hover:bg-primary/30' : 'bg-transparent border-border hover:bg-accent/40 text-muted-foreground')}
                    title={notifyEnabled ? 'Disable message notifications' : 'Enable message notifications'}
                  >
                    {notifyEnabled ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
                    <span className="hidden sm:inline">Notify</span>
                  </button>
                  {metaLoading ? (
                    <span className="text-[11px] px-3 py-1 rounded-full border border-border/50 text-muted-foreground flex items-center gap-1">
                      <span className="h-3 w-3 animate-spin border-2 border-border border-t-transparent rounded-full" />
                      Load
                    </span>
                  ) : owner === anonId ? (
                    <Button
                      variant={isPublic ? 'secondary' : 'default'}
                      size="sm"
                      onClick={async () => {
                        if (visibilityBusy) return;
                        setVisibilityBusy(true);
                        const target = !isPublic; pendingVisibilityRef.current = target; setIsPublic(target);
                        try {
                          const res = await fetch(`/api/room/${roomId}/visibility`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ anonId, isPublic: target }) });
                          if (!res.ok) {
                            pendingVisibilityRef.current = null; setIsPublic(!target); setVisibilityBusy(false);
                          } else {
                            setTimeout(() => { if (pendingVisibilityRef.current !== null) { setVisibilityBusy(false); pendingVisibilityRef.current = null; } }, 4000);
                          }
                        } catch {
                          pendingVisibilityRef.current = null; setIsPublic(!target); setVisibilityBusy(false);
                        }
                      }}
                      disabled={metaLoading || visibilityBusy}
                      title={isPublic ? 'Make room hidden' : 'Make room public'}
                    >{isPublic ? 'Public' : 'Hidden'}</Button>
                  ) : (
                    <span
                      className={'text-[11px] px-2 py-1 rounded-full border font-medium tracking-wide ' + (isPublic
                        ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                        : 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30')}
                      title={isPublic ? 'This room is publicly listed' : 'This room is hidden (private)'}
                    >{isPublic ? 'Public' : 'Hidden'}</span>
                  )}
                  <Button asChild variant="secondary" size="sm" className="shrink-0"><Link href="/">Home</Link></Button>
                </div>
              </div>
            </div>
            <div className="font-bold md:mb-4 md:hidden text-lg flex items-center gap-2 text-foreground">
              <Users className="w-5 h-5" /> Users <span className="ml-2 text-sm font-normal text-muted-foreground">({dedupedUsers.length} connected)</span>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col px-4 flex-1 min-h-0 overflow-hidden">
            <div className="space-y-4 my-2">
              {owner === anonId ? (<CreatePoll roomId={roomId} anonId={anonId as string} />) : null}
              {polls.map(p => (
                <PollCard
                  key={p._id}
                  poll={p}
                  roomId={roomId}
                  anonId={anonId as string}
                  isOwner={owner === anonId}
                  myVotes={myVotes}
                  optimisticPatch={(pollId, patch) => setPolls(prev => prev.map(pol => pol._id === pollId ? { ...pol, ...patch } : pol))}
                  optimisticRemove={(pollId) => setPolls(prev => prev.filter(pol => pol._id !== pollId))}
                />
              ))}
            </div>
            <div ref={messagesContainerRef} className="flex-1 min-h-0 overflow-y-auto space-y-2 mb-4 custom-scrollbar">
              {messages.map((m, i) => {
                const isMine = m.userId === anonId; const isLast = i === messages.length - 1;
                return (
                  <div key={m.id ?? i} className={"rounded p-2 shadow-sm border border-border max-w-[80%] " + (isMine ? 'ml-auto bg-secondary' : 'mr-auto bg-card') + (isLast ? ' animate-fade-lite' : '')}>
                    <span className="font-mono text-xs text-muted-foreground block mb-1">{m.userId}{m.userId === owner ? ' 👑' : ''}</span>
                    <div className="break-words whitespace-pre-wrap text-base">{m.content}</div>
                  </div>
                );
              })}
            </div>
            <form onSubmit={sendMessage} className="flex gap-2 mt-auto pt-2 border-t border-border">
              <Input className="flex-1 text-lg py-6" value={content} onChange={(e) => setContent(e.target.value)} placeholder={anonId ? "Type a message..." : "Initializing..."} disabled={loading || !anonId} required />
              <Button type="submit" className="font-semibold text-lg py-6" disabled={loading || !anonId}>{loading ? <span className="animate-spin mr-2">⏳</span> : null}Send</Button>
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
        /* Hide the room id text fully if the header becomes extremely narrow (<300px) */
        @media (max-width: 360px) {
          #room-id-copy span[data-hide-when-overflow] { display: none; }
        }
      `}</style>
    </div>
  );
}

function CreatePoll({ roomId, anonId }: { roomId: string; anonId: string }) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [opts, setOpts] = useState<string[]>(['', '']);
  const [busy, setBusy] = useState(false);
  const addOpt = () => setOpts(o => [...o, '']);
  const updateOpt = (i: number, v: string) => setOpts(o => o.map((x, idx) => idx === i ? v : x));
  const create = async (e: React.FormEvent) => {
    e.preventDefault(); const options = opts.map(s => s.trim()).filter(Boolean); if (!question.trim() || options.length < 2) return;
    setBusy(true);
    await fetch(`/api/room/${roomId}/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ anonId, question, options }) });
    setQuestion(''); setOpts(['', '']); setBusy(false); setOpen(false);
  };
  return (
    <div className="bg-card rounded border border-border">
      <button type="button" aria-expanded={open} onClick={() => setOpen(v => !v)} className="w-full flex items-center justify-between px-3 py-2 text-left text-sm font-semibold text-foreground hover:bg-accent/40 transition">
        <span>Create poll</span>
        <ChevronDown className={'h-4 w-4 transition-transform ' + (open ? 'rotate-180' : 'rotate-0')} />
      </button>
      {open && (
        <form onSubmit={create} className="p-3 pt-0 space-y-2">
          <Input placeholder="Question" value={question} onChange={e => setQuestion(e.target.value)} disabled={busy} />
          <div className="space-y-2">
            {opts.map((o, i) => (
              <Input key={i} placeholder={`Option ${i + 1}`} value={o} onChange={e => updateOpt(i, e.target.value)} disabled={busy} />
            ))}
          </div>
          <div className="flex gap-2 mt-2">
            <Button type="button" onClick={addOpt} variant="secondary" disabled={busy}>Add option</Button>
            <Button type="submit" disabled={busy}>Create</Button>
          </div>
        </form>
      )}
    </div>
  );
}

function PollCard({ poll, roomId, anonId, isOwner, myVotes, optimisticPatch, optimisticRemove }: { poll: PollClient; roomId: string; anonId: string; isOwner: boolean; myVotes: Record<string, string>; optimisticPatch: (pollId: string, patch: Partial<PollClient>) => void; optimisticRemove: (pollId: string) => void; }) {
  const [busy, setBusy] = useState(false);
  const lastActiveRef = useRef(poll.active);
  useEffect(() => { lastActiveRef.current = poll.active; }, [poll.active]);

  const vote = async (optionId: string) => {
    try {
      setBusy(true);
      const res = await fetch(`/api/room/${roomId}/poll/${poll._id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ anonId, optionId }) });
      if (!res.ok) {
        try { const err = await res.json(); console.error('Vote failed', res.status, err); if (typeof window !== 'undefined') alert(`Vote failed (${res.status}): ${err?.errorCode || err?.error || 'Unknown error'}`); } catch { console.error('Vote failed', res.status); }
      }
    } finally { setBusy(false); }
  };

  const toggle = async () => {
    const optimisticTarget = !poll.active; const previous = poll.active; optimisticPatch(poll._id, { active: optimisticTarget });
    try {
      setBusy(true);
      const res = await fetch(`/api/room/${roomId}/poll/${poll._id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: optimisticTarget, anonId }) });
      if (res.ok) {
        const data = await res.json().catch(() => null); if (data?.unchanged) { if (previous !== poll.active) optimisticPatch(poll._id, { active: previous }); }
      } else {
        let err: unknown = null; try { err = await res.json(); } catch { }
        const code = (err as { errorCode?: string; error?: string } | null | undefined)?.errorCode;
        const benign = code === 'updateReturnedNull' || code === 'pollByIdOrRoomNotFound';
        if (!benign) {
          optimisticPatch(poll._id, { active: previous });
          console.error('Toggle failed', res.status, err);
          if (typeof window !== 'undefined') {
            const msg = code || (err as { error?: string } | null | undefined)?.error || 'Unknown error';
            alert(`Toggle failed (${res.status}): ${msg}`);
          }
        }
      }
    } finally { setBusy(false); }
  };

  const del = async () => {
    const backup = poll; optimisticRemove(poll._id);
    try {
      setBusy(true);
      const res = await fetch(`/api/room/${roomId}/poll/${poll._id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ anonId }) });
      if (!res.ok) {
        let err: unknown = null; try { err = await res.json(); } catch { }
        const code = (err as { errorCode?: string; error?: string } | null | undefined)?.errorCode;
        const benign = code === 'pollByIdOrRoomNotFound' || code === 'deleteReturnedNull';
        if (!benign) {
          optimisticPatch(backup._id, backup);
          console.error('Delete failed', res.status, err);
          if (typeof window !== 'undefined') {
            const msg = code || (err as { error?: string } | null | undefined)?.error || 'Unknown error';
            alert(`Delete failed (${res.status}): ${msg}`);
          }
        }
      }
    } finally { setBusy(false); }
  };

  const totalVotes = poll.options.reduce((sum, o) => sum + (o.votes || 0), 0) || 0;

  return (
    <div className="p-4 rounded-lg border border-border bg-card/60 backdrop-blur-sm shadow-sm hover:bg-card/80 transition-colors">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="font-semibold leading-snug text-foreground break-words text-sm sm:text-base">{poll.question}</div>
          <div className="mt-1 text-[11px] sm:text-xs text-muted-foreground">Total votes: {totalVotes}</div>
        </div>
        <span className={'shrink-0 px-2 py-1 rounded-full text-[10px] font-medium border tracking-wide ' + (poll.active ? 'bg-green-500/15 text-green-400 border-green-500/30' : 'bg-red-500/15 text-red-400 border-red-500/30')}>
          {poll.active ? 'OPEN' : 'CLOSED'}
        </span>
      </div>
      <div className="mt-3 grid gap-2">
        {poll.options.map(o => {
          const selected = myVotes[poll._id] === o._id; const pct = totalVotes > 0 ? Math.round((o.votes * 100) / totalVotes) : 0;
          return (
            <div
              key={o._id}
              className={'group relative overflow-hidden rounded-md border bg-gradient-to-br from-background/40 to-background/10 ' + (selected ? 'border-primary/70 ring-1 ring-primary/40' : 'border-border hover:border-primary/40')}
            >
              <div className="absolute inset-0 pointer-events-none" aria-hidden>
                <div
                  className={(selected ? 'bg-primary/40' : 'bg-muted/60 dark:bg-muted/40') + ' h-full transition-all duration-500 ease-out backdrop-blur-[1px]'}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <Button
                onClick={() => vote(o._id)}
                disabled={busy || !poll.active}
                variant="ghost"
                aria-pressed={selected}
                className={'relative rounded-none z-10 w-full justify-between text-left px-3 py-2 font-medium text-foreground/90 hover:text-foreground ' + (selected ? 'font-semibold' : '')}
                title={selected ? 'You voted this option' : 'Vote this option'}
              >
                <span className="flex-1 pr-4 truncate">{o.text}</span>
                <span className="ml-auto shrink-0 tabular-nums text-xs text-muted-foreground group-hover:text-foreground/80">
                  {pct}% • {o.votes}
                </span>
              </Button>
            </div>
          );
        })}
      </div>
      {isOwner && (
        <div className="flex flex-wrap gap-2 mt-3">
          <Button onClick={toggle} disabled={busy} size="sm" variant={poll.active ? 'secondary' : 'default'}>
            {poll.active ? 'Close Poll' : 'Reopen'}
          </Button>
          <Button onClick={del} disabled={busy} variant="destructive" size="sm">Delete</Button>
        </div>
      )}
    </div>
  );
}
