#!/usr/bin/env node
// Throwaway contract mock. Node stdlib only; state resets on restart.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { extname, join, normalize } from 'node:path';

const port = Number(process.env.MOCK_API_PORT || 3001), dist = process.env.MOCK_WEB_DIST || 'web/dist';
const rooms = new Map(), subs = new Map();
const now = () => new Date().toISOString();
const id = (prefix = '') => prefix + randomBytes(12).toString('base64url');
const anon = () => `anon-${randomBytes(8).toString('hex').slice(0, 10)}`;
const validAnon = value => /^anon-[a-z0-9]{10}$/.test(value || '');
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const fail = (res, status, error) => json(res, status, { error });
const body = async req => { let text = ''; for await (const part of req) { text += part; if (Buffer.byteLength(text) > 8192) throw Error('too_large'); } try { return JSON.parse(text || '{}'); } catch { throw Error('invalid_json'); } };
const emit = (room, type, payload) => { const event = { type, seq: ++room.seq, payload }; room.events.push(event); if (room.events.length > 256) room.events.shift(); const frame = `id: ${event.seq}\nevent: ${type}\ndata: ${JSON.stringify(event)}\n\n`; for (const res of subs.get(room.id) || []) res.write(frame); };
const roomFor = (res, roomId) => { const room = rooms.get(roomId); if (!room) { fail(res, 404, 'room_not_found'); return null; } return room; };
const owner = (room, data) => validAnon(data.anonId) && data.anonId === room.ownerId && data.ownerCapability === room.ownerCapability;
const snapshot = (room, anonId) => ({ users: [...room.users.values()], messages: room.messages, owner: room.ownerId, poll: room.poll, myVote: room.poll?.votes[anonId] || null, isPublic: room.isPublic });
const staticFile = async (req, res, path) => {
  if (!['GET', 'HEAD'].includes(req.method)) return fail(res, 405, 'method_not_allowed');
  const requested = decodeURIComponent(path === '/' ? '/index.html' : path), file = normalize(join(dist, requested));
  if (!file.startsWith(normalize(dist))) return fail(res, 404, 'not_found');
  try { const info = await stat(file); if (!info.isFile()) throw Error(); const data = await readFile(file); const hashed = /[._-][a-f0-9]{8,}[._-]/i.test(file); res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' })[extname(file)] || 'application/octet-stream', 'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache' }); res.end(req.method === 'HEAD' ? undefined : data); } catch { if (extname(requested) || requested.startsWith('/_next/')) return fail(res, 404, 'not_found'); try { const shell = await readFile(join(dist, 'index.html')); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); res.end(req.method === 'HEAD' ? undefined : shell); } catch { fail(res, 404, 'not_found'); } }
};

createServer(async (req, res) => { try {
  const url = new URL(req.url, `http://${req.headers.host}`), p = url.pathname, match = p.match(/^\/api\/room\/([^/]+)(?:\/(join|message|meta|visibility|poll|signal|state|sse))?(?:\/([^/]+))?$/), method = req.method;
  if (!p.startsWith('/api/')) return staticFile(req, res, p);
  if (method === 'GET' && p === '/api/anon') return json(res, 200, { anonId: anon() });
  if (p === '/api/room' && method === 'GET') { const list = [...rooms.values()].filter(r => r.isPublic).sort((a,b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100).map(r => ({ id:r.id, createdAt:r.createdAt, userCount:r.users.size, hasOwner:r.users.get(r.ownerId)?.subscriptions > 0 })); return json(res, 200, { rooms:list, stats:{ totalRooms:rooms.size, activeUsers:[...rooms.values()].reduce((n,r) => n+r.users.size,0), ownersOnline:[...rooms.values()].filter(r => r.users.get(r.ownerId)?.subscriptions > 0).length } }); }
  if (p === '/api/room' && method === 'POST') { const data = await body(req); if (!validAnon(data.anonId)) return fail(res,400,'invalid_anon_id'); const room = { id:id('room-'), ownerId:data.anonId, ownerCapability:id(), createdAt:now(), isPublic:true, users:new Map([[data.anonId,{id:data.anonId,connectedAt:now(),subscriptions:0}]]), messages:[], poll:null, events:[], seq:0 }; rooms.set(room.id,room); return json(res,200,{roomId:room.id,ownerId:room.ownerId,ownerCapability:room.ownerCapability}); }
  if (!match) return fail(res,404,'not_found'); const [, roomId, action, pollId] = match; if (action === 'signal') return fail(res,404,'signal_disabled'); const room = roomFor(res, roomId); if (!room) return;
  if (action === 'meta' && method === 'GET') return json(res,200,{ownerId:room.ownerId,isPublic:room.isPublic,createdAt:room.createdAt});
  if (action === 'state' && method === 'GET') { const a=url.searchParams.get('anonId'); return validAnon(a) ? json(res,200,snapshot(room,a)) : fail(res,400,'invalid_anon_id'); }
  if (action === 'join' && method === 'POST') { const data=await body(req); if (!validAnon(data.anonId)) return fail(res,400,'invalid_anon_id'); if (!room.users.has(data.anonId)) { room.users.set(data.anonId,{id:data.anonId,connectedAt:now(),subscriptions:0}); emit(room,'users',[...room.users.values()]); } return json(res,200,{joined:true,ownerId:room.ownerId}); }
  if (action === 'message' && method === 'POST') { const data=await body(req), content=typeof data.content==='string' && data.content.trim(); if (!validAnon(data.anonId)) return fail(res,400,'invalid_anon_id'); if (!content || Buffer.byteLength(content)>1000) return fail(res,400,'invalid_message'); const message={id:id('msg-'),roomId,userId:data.anonId,content,createdAt:now()}; room.messages.push(message); if(room.messages.length>1000) room.messages.shift(); emit(room,'message',message); return json(res,200,{sent:true,id:message.id}); }
  if (action === 'visibility' && method === 'PATCH') { const data=await body(req); if(typeof data.isPublic!=='boolean') return fail(res,400,'invalid_payload'); if(!owner(room,data)) return fail(res,403,'forbidden'); room.isPublic=data.isPublic; emit(room,'room-visibility',{isPublic:room.isPublic}); return json(res,200,{ok:true,isPublic:room.isPublic}); }
  if (action === 'poll' && !pollId && method === 'GET') return json(res,200,{poll:room.poll && publicPoll(room.poll)});
  if (action === 'poll' && !pollId && method === 'POST') { const data=await body(req); if(!owner(room,data)) return fail(res,403,'forbidden'); if(room.poll) return fail(res,409,'poll_active'); if(typeof data.question!=='string'||!Array.isArray(data.options)||data.options.length<2||data.options.length>8||data.options.some(x=>typeof x!=='string'||!x.trim()||Buffer.byteLength(x)>128)||!data.question.trim()||Buffer.byteLength(data.question)>256)return fail(res,400,'invalid_poll'); room.poll={id:id('poll-'),question:data.question.trim(),options:data.options.map(text=>({id:id('opt-'),text:text.trim(),votes:0})),createdAt:now(),votes:{}}; emit(room,'poll',publicPoll(room.poll)); return json(res,200,{pollId:room.poll.id}); }
  if(action==='poll'&&pollId){ const data=await body(req); if(!room.poll||room.poll.id!==pollId) return fail(res,404,'poll_not_found'); if(method==='POST'){if(!validAnon(data.anonId)||typeof data.optionId!=='string'||!room.poll.options.some(o=>o.id===data.optionId))return fail(res,400,'invalid_vote'); const old=room.poll.votes[data.anonId]; if(old)room.poll.options.find(o=>o.id===old).votes--; room.poll.votes[data.anonId]=data.optionId; room.poll.options.find(o=>o.id===data.optionId).votes++; emit(room,'vote',{pollId,anonId:data.anonId,optionId:data.optionId,options:room.poll.options});return json(res,200,{ok:true});} if(!owner(room,data))return fail(res,403,'forbidden'); if(method==='PATCH'){if(data.active!==false)return fail(res,400,'invalid_payload');room.poll=null;emit(room,'poll',null);return json(res,200,{ok:true});}if(method==='DELETE'){room.poll=null;emit(room,'poll',null);return json(res,200,{ok:true,deleted:true});}}
  if(action==='sse'&&method==='GET'){const a=url.searchParams.get('anonId');if(!validAnon(a)){res.writeHead(400,{'Content-Type':'text/plain'});return res.end('Missing anonId');} res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'}); const set=subs.get(roomId)||new Set();set.add(res);subs.set(roomId,set); emitTo(res,room,'snapshot',snapshot(room,a)); const ping=setInterval(()=>res.write(': ping\n\n'),15000);req.on('close',()=>{clearInterval(ping);set.delete(res);if(!set.size)subs.delete(roomId);});return;}
  fail(res,405,'method_not_allowed');
} catch (error) { fail(res,error.message==='too_large'?400:400,error.message==='too_large'?'invalid_payload':'invalid_payload'); } }).listen(port, () => console.log(`mock API http://127.0.0.1:${port}`));

function publicPoll(poll) { return { id:poll.id, question:poll.question, options:poll.options, createdAt:poll.createdAt }; }
function emitTo(res, room, type, payload) { const event={type,seq:room.seq,payload}; res.write(`id: ${event.seq}\nevent: ${type}\ndata: ${JSON.stringify(event)}\n\n`); }