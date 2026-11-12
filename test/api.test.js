// API- en realtime-integratie: echte HTTP-server, echte sockets, meerdere clients.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io as ioc } from 'socket.io-client';
import { buildApp } from '../server/app.js';

let app, base, dir;
const PW = 'test-wachtwoord';
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bamigo-'));
  app = await buildApp({ dbFile: path.join(dir, 'db.sqlite'), mediaDir: path.join(dir, 'media'), adminPassword: PW });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
});
const allClients = [];
after(async () => { allClients.forEach(c => c.disconnect()); await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const req = async (method, url, { body, headers = {} } = {}) => {
  const r = await fetch(base + url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, text };
};
const S = t => ({ 'x-staff-token': t });
const P = t => ({ 'x-player-token': t });
const sleep = ms => new Promise(r => setTimeout(r, ms));

function client(kind, token) {
  const s = ioc(base, { auth: { kind, token }, transports: ['websocket'], forceNew: true, reconnection: false });
  allClients.push(s);
  s.views = []; s.on('state', v => s.views.push(v));
  s.last = () => s.views.at(-1);
  s.ready = new Promise((res, rej) => { s.once('state', res); s.once('connect_error', rej); });
  return s;
}
const waitFor = async (fn, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return; await sleep(20); } throw new Error('timeout'); };

async function makeEvent() {
  const ev = (await req('POST', '/api/events', { body: { name: 'API-test', settings: { countdownMs: 300 } }, headers: { 'x-admin-password': PW } })).data;
  const owner = ev.ownerToken;
  const teams = [];
  for (const n of ['A', 'B', 'C', 'D', 'E']) teams.push((await req('POST', '/api/staff/teams', { body: { name: n }, headers: S(owner) })).data.id);
  const players = [];
  const layout = [2, 2, 2, 2, 3];
  for (let i = 0; i < 5; i++) for (let j = 0; j < layout[i]; j++) {
    const r = await req('POST', '/api/join', { body: { code: ev.joinCode, name: `Speler${i}${j}`, teamId: teams[i] } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    players.push({ token: r.data.token, team: i, captain: j === 0 });
  }
  const round = (await req('POST', '/api/staff/rounds', { body: { title: 'R', kind: 'quiz' }, headers: S(owner) })).data.id;
  return { ...ev, owner, teams, players, round };
}

test('aanmaken vereist het beheerwachtwoord', async () => {
  assert.equal((await req('POST', '/api/events', { body: { name: 'x' } })).status, 401);
  assert.equal((await req('POST', '/api/events', { body: { name: 'x' }, headers: { 'x-admin-password': 'fout' } })).status, 401);
});

test('autorisatie: geen antwoorden, geen andere avonden, geen privé-media voor onbevoegden', async () => {
  const e1 = await makeEvent(); const e2 = await makeEvent();
  const q = (await req('POST', '/api/staff/questions', { body: { roundId: e1.round, type: 'mc', prompt: 'GEHEIM?', options: ['a', 'ANTWOORD-X'], key: { correct: 1, explanation: 'SLEUTEL-UITLEG' } }, headers: S(e1.owner) })).data.id;
  // speler van e1
  const pv = await req('GET', '/api/player/view', { headers: P(e1.players[0].token) });
  assert.equal(pv.status, 200);
  assert.ok(!pv.text.includes('SLEUTEL') && !pv.text.includes('GEHEIM'));
  // spelertoken werkt niet als beheertoken
  assert.equal((await req('GET', '/api/staff/view', { headers: S(e1.players[0].token) })).status, 401);
  assert.equal((await req('GET', '/api/staff/export/pack', { headers: S(e1.players[0].token) })).status, 401);
  // zonder token
  assert.equal((await req('GET', '/api/staff/view')).status, 401);
  assert.equal((await req('GET', '/api/player/view')).status, 401);
  // eigenaar van e2 kan vraag van e1 niet bewerken/verwijderen
  assert.equal((await req('DELETE', '/api/staff/questions/' + q, { headers: S(e2.owner) })).status, 404);
  assert.equal((await req('POST', '/api/staff/questions', { body: { id: q, roundId: e1.round, type: 'mc', prompt: 'gekaapt', options: ['a', 'b'] }, headers: S(e2.owner) })).status, 404);
  const pack2 = await req('GET', '/api/staff/export/pack', { headers: S(e2.owner) });
  assert.ok(!pack2.text.includes('GEHEIM'));
  // rollen: tv-link en spoilervrij mogen geen inhoud
  const sf = (await req('POST', '/api/staff/grants', { body: { role: 'spoilerfree', label: 'Reno' }, headers: S(e1.owner) })).data.url.split('#k=')[1];
  const tv = (await req('POST', '/api/staff/grants', { body: { role: 'display' }, headers: S(e1.owner) })).data.url.split('#k=')[1];
  const host = (await req('POST', '/api/staff/grants', { body: { role: 'host' }, headers: S(e1.owner) })).data.url.split('#k=')[1];
  for (const t of [sf, tv, host]) {
    assert.equal((await req('GET', '/api/staff/export/pack', { headers: S(t) })).status, 403);
    assert.equal((await req('GET', '/api/staff/emergency', { headers: S(t) })).status, 403);
    assert.equal((await req('POST', '/api/staff/questions', { body: { roundId: e1.round, type: 'tf', prompt: 'x' }, headers: S(t) })).status, 403);
  }
  const sfv = await req('GET', '/api/staff/view', { headers: S(sf) });
  assert.ok(!sfv.text.includes('GEHEIM') && !sfv.text.includes('SLEUTEL'));
  const hv = await req('GET', '/api/staff/view', { headers: S(host) });
  assert.ok(!hv.text.includes('SLEUTEL'), 'host ziet sleutel niet vooraf');
  assert.equal((await req('POST', '/api/staff/live', { body: { action: 'screen_lobby' }, headers: S(sf) })).status, 403);
  // eigenaarslink kan niet nog een eigenaar maken
  assert.equal((await req('POST', '/api/staff/grants', { body: { role: 'owner' }, headers: S(e1.owner) })).status, 403);
  // ingetrokken link werkt niet meer
  const g = (await req('GET', '/api/staff/view', { headers: S(e1.owner) })).data.grants.find(x => x.role === 'host');
  await req('POST', `/api/staff/grants/${g.id}/revoke`, { headers: S(e1.owner) });
  assert.equal((await req('GET', '/api/staff/view', { headers: S(host) })).status, 401);
  // media: upload + toegang
  const fd = new FormData();
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8ffbf1e000502027f8c7ae5f30000000049454e44ae426082', 'hex');
  fd.append('file', new Blob([png], { type: 'image/png' }), 'x.png');
  const up = await fetch(base + '/api/staff/media', { method: 'POST', headers: S(e1.owner), body: fd });
  const mid = (await up.json()).id; assert.ok(mid);
  const bad = new FormData(); bad.append('file', new Blob([Buffer.from('<script>')], { type: 'image/png' }), 'x.png');
  assert.equal((await fetch(base + '/api/staff/media', { method: 'POST', headers: S(e1.owner), body: bad })).status, 400);
  assert.equal((await fetch(base + '/api/media/' + mid)).status, 403);
  assert.equal((await fetch(base + '/api/media/' + mid, { headers: P(e1.players[0].token) })).status, 403, 'speler ziet media niet vóór de vraag');
  assert.equal((await fetch(base + '/api/media/' + mid, { headers: S(e2.owner) })).status, 403, 'andere avond');
  assert.equal((await fetch(base + '/api/media/' + mid, { headers: S(e1.owner) })).status, 200);
});

test('elf spelers, tv en host: volledige meerkeuzeronde via sockets', async () => {
  const e = await makeEvent();
  const tvTok = (await req('POST', '/api/staff/grants', { body: { role: 'display' }, headers: S(e.owner) })).data.url.split('#k=')[1];
  const q = (await req('POST', '/api/staff/questions', { body: { roundId: e.round, type: 'mc', prompt: 'Welke?', options: ['a', 'b', 'c', 'd'], seconds: 3, points: 1, key: { correct: 2 } }, headers: S(e.owner) })).data.id;
  const socks = e.players.map(p => client('player', p.token));
  const tv = client('staff', tvTok); const host = client('staff', e.owner);
  await Promise.all([...socks, tv, host].map(s => s.ready));
  await waitFor(() => tv.last().teams.reduce((a, t) => a + t.online, 0) === 11);
  const seq = () => host.last().live.seq;
  let r = await req('POST', '/api/staff/live', { body: { action: 'prepare', questionId: q, seq: seq() }, headers: S(e.owner) });
  assert.equal(r.status, 200);
  await waitFor(() => host.last().live.phase === 'ready');
  r = await req('POST', '/api/staff/live', { body: { action: 'open', seq: seq() }, headers: S(e.owner) });
  // dubbele klik met oude seq → 409
  const dbl = await req('POST', '/api/staff/live', { body: { action: 'open', seq: r.data.live.seq - 1 }, headers: S(e.owner) });
  assert.equal(dbl.status, 409);
  await waitFor(() => socks[0].last().question?.visible === true, 3000);
  assert.ok(!JSON.stringify(tv.last()).includes('"correct"'), 'tv krijgt geen sleutel');
  // alle spelers tikken; alleen captains tellen; elke captain tikt twee keer (dubbele tap)
  const results = await Promise.all(socks.map((s, i) => new Promise(res => {
    const ans = e.players[i].team % 2 === 0 ? 2 : 1;
    s.emit('submit', { questionId: q, answer: ans }, a1 => s.emit('submit', { questionId: q, answer: 0 }, a2 => res([a1, a2])));
  })));
  const captains = results.filter((_, i) => e.players[i].captain);
  assert.ok(captains.every(([a1, a2]) => a1.ok && !a1.duplicate && a2.ok && a2.duplicate));
  assert.ok(results.filter((_, i) => !e.players[i].captain).every(([a1]) => !a1.ok && /captain/.test(a1.error)));
  await waitFor(() => tv.last().counts?.submitted === 5);
  // wacht op automatische sluiting door de servertimer
  await waitFor(() => host.last().live.phase === 'closed', 5000);
  const late = await new Promise(res => socks[0].emit('submit', { questionId: q, answer: 2 }, res));
  assert.equal(late.duplicate, true, 'na sluiten: bestaande inzending, geen nieuwe');
  await req('POST', '/api/staff/live', { body: { action: 'reveal', seq: seq() }, headers: S(e.owner) });
  await waitFor(() => socks[0].last().live.phase === 'revealed');
  assert.deepEqual(tv.last().result.distribution, [0, 2, 3, 0]);
  await req('POST', '/api/staff/live', { body: { action: 'score', seq: seq() }, headers: S(e.owner) });
  await waitFor(() => socks[0].last().live.phase === 'scored');
  const me0 = socks[0].last();
  assert.equal(me0.mine.verdict, 'correct'); assert.equal(me0.mine.points, 1);
  const sb = host.last().scoreboard.teams;
  assert.deepEqual(sb.map(t => [t.name, t.points]).sort(), [['A', 1], ['B', 0], ['C', 1], ['D', 0], ['E', 1]]);
  // reconnect: nieuwe socket krijgt direct de actuele state
  socks[3].disconnect();
  const again = client('player', e.players[3].token); await again.ready;
  assert.equal(again.last().live.phase, 'scored'); assert.equal(again.last().mine.verdict, 'wrong');
  for (const s of [...socks, tv, host, again]) s.disconnect();
});

test('herladen: sessie hervat met hetzelfde token; naam kan niet gekaapt worden', async () => {
  const e = await makeEvent();
  const v1 = await req('GET', '/api/player/view', { headers: P(e.players[0].token) });
  assert.equal(v1.data.me.name, 'Speler00');
  const steal = await req('POST', '/api/join', { body: { code: e.joinCode, name: 'speler00' } });
  assert.equal(steal.status, 409);
  // host maakt nieuwe persoonlijke link: oude sessie vervalt
  const pid = v1.data.me.id;
  const link = await req('POST', `/api/staff/participants/${pid}/link`, { headers: S(e.owner) });
  const newTok = link.data.url.split('#t=')[1];
  assert.equal((await req('GET', '/api/player/view', { headers: P(e.players[0].token) })).status, 401);
  assert.equal((await req('GET', '/api/player/view', { headers: P(newTok) })).data.me.id, pid);
});

test('code raden wordt afgeremd', async () => {
  let last;
  for (let i = 0; i < 32; i++) last = await req('GET', '/api/join/ZZZZZ' + i);
  assert.equal(last.status, 429);
});

