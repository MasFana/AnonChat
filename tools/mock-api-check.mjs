import assert from 'node:assert/strict';
const base = process.env.MOCK_API_URL || 'http://127.0.0.1:3001';
const call = async (path, method = 'GET', body) => { const r = await fetch(base + path, { method, headers: body ? { 'content-type':'application/json' } : undefined, body: body && JSON.stringify(body) }); return [r, await r.json()]; };
const [, identity] = await call('/api/anon'); assert.match(identity.anonId, /^anon-[a-z0-9]{10}$/);
let [r, created] = await call('/api/room','POST',{anonId:identity.anonId}); assert.equal(r.status,200); assert.ok(created.ownerCapability);
[r] = await call(`/api/room/${created.roomId}/message`,'POST',{anonId:identity.anonId,content:'ok'}); assert.equal(r.status,200);
[r] = await call(`/api/room/${created.roomId}/visibility`,'PATCH',{anonId:identity.anonId,isPublic:false}); assert.equal(r.status,403);
[r] = await call('/api/room/not-a-room/signal'); assert.equal(r.status,404);
console.log('mock-api-check: pass');