"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Bell, BellOff, ChevronDown, MessageCircle, Users } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { anonId, api, capability, type Message, type Poll, type Snapshot, type User } from "@/lib/api";
import { limits, validText } from "@/lib/limits";

const errorText = (error: unknown, fallback: string) => {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const notices: Record<string, string> = {
    invalid_anon_id: "Anonymous identity expired. Refresh and try again.",
    room_not_found: "Room not found.",
    room_closed: "Room closed.",
    forbidden: "Owner permission required.",
    poll_active: "A poll is already active.",
    poll_closed: "Poll closed.",
    invalid_poll: "Enter a question and 2 to 8 options.",
    invalid_vote: "Invalid vote.",
    invalid_message: "Message is empty or too long.",
    rate_limited: "Too many requests. Try again shortly.",
  };
  return notices[code] || (error instanceof Error ? error.message : fallback);
};

export default function RoomClient({ roomId }: { roomId: string }) {
  const [id, setId] = useState("");
  const [users, setUsers] = useState<User[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [owner, setOwner] = useState("");
  const [poll, setPoll] = useState<Poll | null>(null);
  const [myVote, setMyVote] = useState<string | null>(null);
  const [isPublic, setPublic] = useState(false);
  const [content, setContent] = useState("");
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [pollOpen, setPollOpen] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("Connecting");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [notifyEnabled, setNotifyEnabled] = useState(false);
  const sequence = useRef(0);
  const eventSource = useRef<EventSource | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchdogTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backoff = useRef(1000);
  const messageBox = useRef<HTMLDivElement | null>(null);
  const nearBottom = useRef(true);
  const stopped = useRef(false);
  const idRef = useRef("");
  const notifyRef = useRef(false);
  const lastNotifiedId = useRef<string | undefined>(undefined);

  useEffect(() => { idRef.current = id; }, [id]);
  useEffect(() => { notifyRef.current = notifyEnabled; }, [notifyEnabled]);
  useEffect(() => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    if (!error) return;
    noticeTimer.current = setTimeout(() => setError(""), 5000);
    return () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); };
  }, [error]);
  useEffect(() => {
    const enabled = typeof window !== "undefined" &&
      localStorage.getItem("roomNotifyEnabled") === "1" &&
      typeof Notification !== "undefined" &&
      Notification.permission === "granted";
    setNotifyEnabled(enabled);
    if (!enabled && typeof window !== "undefined") localStorage.removeItem("roomNotifyEnabled");
  }, []);

  useEffect(() => { anonId().then(setId).catch(error => setError(errorText(error, "Cannot establish anonymous identity."))); }, []);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    stopped.current = false;
    const clearTimers = () => { if (reconnectTimer.current) clearTimeout(reconnectTimer.current); if (watchdogTimer.current) clearTimeout(watchdogTimer.current); };
    const stopSource = (source: EventSource) => { source.close(); if (eventSource.current === source) eventSource.current = null; if (watchdogTimer.current) { clearTimeout(watchdogTimer.current); watchdogTimer.current = null; } };
    const applySnapshot = (state: Snapshot, seq: number) => { setUsers(state.users || []); setMessages((state.messages || []).slice(-limits.retainedMessages)); setOwner(state.owner || ""); setPoll(state.poll || null); setMyVote(state.myVote || null); setPublic(!!state.isPublic); sequence.current = seq; };
    const notify = (message: Message) => {
      if (typeof Notification === "undefined" || Notification.permission !== "granted") {
        notifyRef.current = false;
        setNotifyEnabled(false);
        localStorage.removeItem("roomNotifyEnabled");
        return;
      }
      if (!notifyRef.current) return;
      if (message.userId === idRef.current) return;
      if (lastNotifiedId.current === message.id) return;
      lastNotifiedId.current = message.id;
      try {
        const notification = new Notification(message.content.slice(0, 160) || "New message", { tag: message.id || `${roomId}-latest` });
        const closeTimer = setTimeout(() => notification.close(), 5000);
        notification.onclick = () => { window.focus(); clearTimeout(closeTimer); };
      } catch {
        notifyRef.current = false;
        setNotifyEnabled(false);
        localStorage.removeItem("roomNotifyEnabled");
        setError("");
      }
    };
    const schedule = (connect: () => void) => { if (cancelled || stopped.current || reconnectTimer.current) return; setStatus("Reconnecting"); reconnectTimer.current = setTimeout(() => { reconnectTimer.current = null; connect(); }, backoff.current); backoff.current = Math.min(backoff.current * 2, 30000); };
    const connect = () => {
      if (cancelled || stopped.current) return;
      void api.meta(roomId).then(meta => {
        if (cancelled || stopped.current) return Promise.reject(new Error("cancelled"));
        setOwner(meta.ownerId); setPublic(meta.isPublic);
        return api.join(roomId, id);
      }).then(() => {
        if (cancelled || stopped.current) return;
        eventSource.current?.close();
        if (watchdogTimer.current) { clearTimeout(watchdogTimer.current); watchdogTimer.current = null; }
        const source = new EventSource(`${api.sse(roomId, id)}&lastEventId=${sequence.current}`);
        eventSource.current = source;
        const touch = () => { if (watchdogTimer.current) clearTimeout(watchdogTimer.current); watchdogTimer.current = setTimeout(() => { if (eventSource.current !== source) return; stopSource(source); schedule(connect); }, 35000); };
        const receive = async (type: string, event: Event) => {
          if (eventSource.current !== source) return;
          touch();
          try {
            const data = JSON.parse((event as MessageEvent).data) as { seq?: number; payload: unknown };
            const seq = data.seq || Number((event as MessageEvent).lastEventId) || 0;
            if (type === "snapshot") { applySnapshot(data.payload as Snapshot, seq); return; }
            if (seq && sequence.current && seq > sequence.current + 1) { applySnapshot(await api.state(roomId, id), seq); return; }
            if (seq && seq <= sequence.current) return;
            if (seq) sequence.current = seq;
            if (type === "message") { const message = data.payload as Message; setMessages(items => [...items, message].slice(-limits.retainedMessages)); notify(message); }
            if (type === "users") setUsers(data.payload as User[]);
            if (type === "poll") { setPoll(data.payload as Poll | null); if (!data.payload) setMyVote(null); }
            if (type === "vote") { const vote = data.payload as { pollId: string; anonId: string; optionId: string; options: Poll["options"] }; setPoll(current => current?.id === vote.pollId ? { ...current, options: vote.options } : current); if (vote.anonId === id) setMyVote(vote.optionId); }
            if (type === "room-visibility") setPublic((data.payload as { isPublic: boolean }).isPublic);
            if (type === "room-deleted") { stopped.current = true; stopSource(source); location.assign("/?msg=Room%20Closed"); }
          } catch (eventError) { setError(errorText(eventError, "Invalid live update.")); }
        };
        ["snapshot", "message", "users", "poll", "vote", "room-visibility", "room-deleted"].forEach(type => source.addEventListener(type, event => void receive(type, event)));
        source.addEventListener("ping", touch);
        source.onopen = () => { if (eventSource.current !== source) return; setStatus("Live"); setError(""); backoff.current = 1000; touch(); };
        source.onerror = () => { if (!stopped.current && eventSource.current === source) { stopSource(source); schedule(connect); } };
      }).catch(error => {
        if (cancelled || stopped.current) return;
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        if (code === "room_not_found" || code === "room_closed") {
          stopped.current = true;
          location.assign(`/?msg=${encodeURIComponent(code === "room_closed" ? "Room Closed" : "Room not found")}`);
          return;
        }
        setError(errorText(error, "Cannot connect to room."));
        schedule(connect);
      });
    };
    connect();
    return () => { cancelled = true; stopped.current = true; eventSource.current?.close(); clearTimers(); };
  }, [id, roomId]);

  useEffect(() => { if (nearBottom.current && messageBox.current) messageBox.current.scrollTop = messageBox.current.scrollHeight; }, [messages]);

  const dedupedUsers = useMemo(() => {
    const seen = new Set<string>();
    const list: User[] = [];
    for (const user of users) { if (!seen.has(user.id)) { seen.add(user.id); list.push(user); } }
    return list;
  }, [users]);

  const ownerHere = id === owner && !!capability(roomId);

  const copyRoomId = async () => {
    try { await navigator.clipboard.writeText(roomId); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* clipboard unavailable */ }
  };

  const toggleNotify = async () => {
    if (notifyEnabled) {
      setNotifyEnabled(false);
      notifyRef.current = false;
      localStorage.removeItem("roomNotifyEnabled");
      return;
    }
    if (typeof Notification === "undefined") {
      setError("Browser notifications are not supported.");
      return;
    }
    let permission: NotificationPermission;
    try {
      permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    } catch {
      setError("Browser notification permission could not be requested.");
      return;
    }
    if (permission !== "granted") {
      setNotifyEnabled(false);
      notifyRef.current = false;
      localStorage.removeItem("roomNotifyEnabled");
      setError("");
      return;
    }
    setNotifyEnabled(true);
    notifyRef.current = true;
    localStorage.setItem("roomNotifyEnabled", "1");
    setError("");
  };

  const toggleVisibility = async () => {
    const target = !isPublic; setPublic(target);
    try { await api.visibility(roomId, id, target); } catch (error) { setPublic(!target); setError(errorText(error, "Cannot update visibility.")); }
  };

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    const text = content.trim();
    if (!validText(text, limits.messageBytes)) { setError(errorText({ code: "invalid_message" }, "Message is empty or too long.")); return; }
    try { await api.message(roomId, id, text); setContent(""); } catch (error) { setError(errorText(error, "Cannot send message.")); }
  };

  const addOption = () => setOptions(items => (items.length >= limits.pollOptions ? items : [...items, ""]));

  const createPoll = async (event: React.FormEvent) => {
    event.preventDefault();
    const cleanOptions = options.map(option => option.trim()).filter(Boolean);
    if (!validText(question, limits.pollQuestionBytes) || cleanOptions.length < 2 || cleanOptions.some(option => !validText(option, limits.pollOptionBytes))) {
      setError(errorText({ code: "invalid_poll" }, "Enter a question and 2 to 8 options."));
      return;
    }
    setBusy(true);
    try { await api.createPoll(roomId, id, question.trim(), cleanOptions); setQuestion(""); setOptions(["", ""]); setPollOpen(false); } catch (error) { setError(errorText(error, "Cannot create poll.")); } finally { setBusy(false); }
  };

  const vote = async (optionId: string) => {
    if (!poll) return;
    const previous = myVote;
    setMyVote(optionId);
    try { await api.vote(roomId, poll.id, id, optionId); } catch (error) { setMyVote(previous); setError(errorText(error, "Cannot cast vote.")); }
  };

  const mutatePoll = async (remove: boolean) => {
    if (!poll) return;
    setBusy(true);
    try { if (remove) await api.deletePoll(roomId, poll.id, id); else await api.closePoll(roomId, poll.id, id); } catch (error) { setError(errorText(error, "Cannot update poll.")); } finally { setBusy(false); }
  };

  const totalVotes = poll ? poll.options.reduce((sum, option) => sum + option.votes, 0) : 0;

  return (
    <div className="flex flex-col md:flex-row h-screen overflow-hidden bg-background">
      <aside className="hidden md:flex w-full md:w-48 bg-card p-4 flex-col gap-2 border-r border-border overflow-hidden">
        <div className="font-bold mb-2 text-lg flex flex-col gap-2 text-foreground">
          <div className="flex items-center gap-2"><Users className="w-5 h-5" /> Users</div>
          <span className="text-sm font-normal text-muted-foreground">({dedupedUsers.length} connected · {status})</span>
        </div>
        <div className="flex-1 min-h-0 flex flex-col gap-1 overflow-y-auto custom-scrollbar pr-1">
          {dedupedUsers.map(user => (
            <div key={user.id} className={user.id === owner ? "font-bold text-primary flex items-center gap-1" : "flex items-center gap-1 text-foreground"}>
              {user.id === owner ? <span title="Owner">👑</span> : null}
              <span className="truncate text-muted-foreground">{user.id === id ? "You" : user.id}</span>
            </div>
          ))}
        </div>
      </aside>
      <main className="flex-1 flex flex-col items-center overflow-hidden w-full">
        <Card className="w-full flex flex-col flex-1 py-4 h-full max-h-full border-border rounded-none bg-card gap-0">
          <CardHeader className="px-4">
            <div className="flex items-center gap-2 w-full">
              <CardTitle className="flex items-center gap-2 text-foreground text-base sm:text-lg min-w-0 flex-1">
                <MessageCircle className="w-5 h-5 shrink-0" />
                <span className="hidden sm:inline shrink-0">Room:</span>
                <button
                  type="button"
                  onClick={copyRoomId}
                  className="relative font-mono px-2 py-1 rounded hover:bg-accent/40 border border-transparent hover:border-accent/40 transition focus-visible:ring-2 focus-visible:ring-primary/50 max-w-[40vw] sm:max-w-[320px] overflow-hidden"
                  title="Click to copy room ID"
                >
                  <span className="select-all block truncate">{roomId}</span>
                  {copied && <span className="pointer-events-none absolute top-0 right-0 -translate-y-full text-[10px] tracking-wide text-emerald-300">Copied!</span>}
                </button>
              </CardTitle>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={toggleNotify}
                  className={"flex items-center gap-1 px-2 py-1 rounded border text-[11px] font-medium transition " + (notifyEnabled ? "bg-primary/20 border-primary/40 text-primary-foreground/90 hover:bg-primary/30" : "bg-transparent border-border hover:bg-accent/40 text-muted-foreground")}
                  title={notifyEnabled ? "Disable message notifications" : "Enable message notifications"}
                >
                  {notifyEnabled ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
                  <span className="hidden sm:inline">Notify</span>
                </button>
                {ownerHere ? (
                  <Button variant={isPublic ? "secondary" : "default"} size="sm" onClick={toggleVisibility} title={isPublic ? "Make room hidden" : "Make room public"}>
                    {isPublic ? "Public" : "Hidden"}
                  </Button>
                ) : (
                  <span
                    className={"text-[11px] px-2 py-1 rounded-full border font-medium tracking-wide " + (isPublic ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" : "bg-zinc-500/15 text-zinc-300 border-zinc-500/30")}
                    title={isPublic ? "This room is publicly listed" : "This room is hidden (private)"}
                  >{isPublic ? "Public" : "Hidden"}</span>
                )}
                <Button asChild variant="secondary" size="sm"><Link href="/">Home</Link></Button>
              </div>
            </div>
            <div className="font-bold md:hidden text-lg flex items-center gap-2 text-foreground">
              <Users className="w-5 h-5" /> Users <span className="ml-2 text-sm font-normal text-muted-foreground">({dedupedUsers.length} connected · {status})</span>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col px-4 flex-1 min-h-0 overflow-hidden">
            {error && <p role="alert" className="mb-2 text-sm text-amber-300">{error}</p>}
            <div className="space-y-3 my-2">
              {ownerHere && !poll && (
                <div className="bg-card rounded border border-border">
                  <button type="button" aria-expanded={pollOpen} onClick={() => setPollOpen(value => !value)} className="w-full flex items-center justify-between px-3 py-2 text-left text-sm font-semibold text-foreground hover:bg-accent/40 transition">
                    <span>Create poll</span>
                    <ChevronDown className={"h-4 w-4 transition-transform " + (pollOpen ? "rotate-180" : "rotate-0")} />
                  </button>
                  {pollOpen && (
                    <form onSubmit={createPoll} className="p-3 pt-0 space-y-2">
                      <Input placeholder="Question" value={question} onChange={event => setQuestion(event.target.value)} disabled={busy} />
                      {options.map((option, index) => (
                        <Input key={index} placeholder={`Option ${index + 1}`} value={option} onChange={event => setOptions(items => items.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} disabled={busy} />
                      ))}
                      <div className="flex gap-2 mt-2">
                        <Button type="button" onClick={addOption} variant="secondary" disabled={busy || options.length >= limits.pollOptions}>Add option</Button>
                        <Button type="submit" disabled={busy}>Create</Button>
                      </div>
                    </form>
                  )}
                </div>
              )}
              {poll && (
                <div className="p-4 rounded-lg border border-border bg-card/60 shadow-sm">
                  <div className="font-semibold leading-snug text-foreground break-words text-sm sm:text-base">{poll.question}</div>
                  <div className="mt-1 text-[11px] sm:text-xs text-muted-foreground">Total votes: {totalVotes}</div>
                  <div className="mt-3 grid gap-2">
                    {poll.options.map(option => {
                      const selected = myVote === option.id;
                      const pct = totalVotes > 0 ? Math.round((option.votes * 100) / totalVotes) : 0;
                      return (
                        <button
                          key={option.id}
                          onClick={() => void vote(option.id)}
                          className={"group relative overflow-hidden rounded-md border text-left p-2 " + (selected ? "border-primary/70 ring-1 ring-primary/40" : "border-border hover:border-primary/40")}
                        >
                          <div className="absolute inset-0 pointer-events-none" aria-hidden>
                            <div className={(selected ? "bg-primary/30" : "bg-muted/40") + " h-full transition-all duration-500 ease-out"} style={{ width: `${pct}%` }} />
                          </div>
                          <div className="relative flex items-center justify-between gap-2 text-sm">
                            <span className="break-words">{option.text}</span>
                            <span className="text-xs text-muted-foreground shrink-0">{option.votes} · {pct}%</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                  {ownerHere && (
                    <div className="mt-3 flex gap-2">
                      <Button size="sm" variant="secondary" disabled={busy} onClick={() => void mutatePoll(false)}>Close</Button>
                      <Button size="sm" variant="destructive" disabled={busy} onClick={() => void mutatePoll(true)}>Delete</Button>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div ref={messageBox} onScroll={event => { const box = event.currentTarget; nearBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < 80; }} className="flex-1 min-h-0 overflow-y-auto space-y-2 mb-4 custom-scrollbar">
              {messages.map((message, index) => {
                const isMine = message.userId === id;
                const isLast = index === messages.length - 1;
                return (
                  <div key={message.id} className={"rounded p-2 shadow-sm border border-border max-w-[80%] " + (isMine ? "ml-auto bg-secondary" : "mr-auto bg-card") + (isLast ? " animate-fade-lite" : "")}>
                    <span className="font-mono text-xs text-muted-foreground block mb-1">{isMine ? "You" : message.userId}{message.userId === owner ? " 👑" : ""}</span>
                    <div className="break-words whitespace-pre-wrap text-base">{message.content}</div>
                    <time className="text-xs text-muted-foreground">{new Date(message.createdAt).toLocaleString()}</time>
                  </div>
                );
              })}
            </div>
            <form onSubmit={send} className="flex gap-2 mt-auto pt-2 border-t border-border">
              <Input aria-label="Message" value={content} onChange={event => setContent(event.target.value)} placeholder="Type a message..." className="flex-1" required />
              <Button type="submit">Send</Button>
            </form>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
