// Belastingtest: N deelnemers antwoorden vrijwel tegelijk, met dubbele taps en reconnects.
// Gebruik: node test/load.js [aantal=100] [rondes=5]
// Start zelf een server (in-process) met een tijdelijke database.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io as ioc } from 'socket.io-client';
import { buildApp } from '../server/app.js';

const N = Number(process.argv[2] || 100), ROUNDS = Number(process.argv[3] || 5);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bamigo-load-'));
const app = await buildApp({ dbFile: path.join(dir, 'db.sqlite'), mediaDir: path.join(dir, 'm'), adminPassword: 'x' });
await app.listen({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${app.server.address().port}`;
const post = async (u, body, h = {}) => (await fetch(base + u, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(body) })).json();
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ev = await post('/api/events', { name: 'Load', mode: 'individual', settings: { countdownMs: 500 } }, { 'x-admin-password': 'x' });
const S = { 'x-staff-token': ev.ownerToken };
const round = (await post('/api/staff/rounds', { title: 'Bliksem', kind: 'lightning' }, S)).id;
const qs = [];
for (let i = 0; i < ROUNDS; i++) qs.push((await post('/api/staff/questions', { roundId: round, type: 'mc', scope: 'individual', scoring: 'speed', prompt: 'Q' + i, options: ['a', 'b', 'c', 'd'], seconds: 10, key: { correct: i % 4 } }, S)).id);

const tokens = [];
for (let i = 0; i < N; i++) tokens.push((await post('/api/join', { code: ev.joinCode, name: 'P' + i })).token);
const mk = t => new Promise(res => { const s = ioc(base, { auth: { kind: 'player', token: t }, transports: ['websocket'], forceNew: true }); s.last = null; s.on('state', v => { s.last = v; }); s.once('state', () => res(s)); });
let socks = await Promise.all(tokens.map(mk));
const hostSock = ioc(base, { auth: { kind: 'staff', token: ev.ownerToken }, transports: ['websocket'], forceNew: true });
let hv; hostSock.on('state', v => { hv = v; });
while (!hv) await sleep(20);
console.log(`Verbonden: ${N} spelers + host. Node ${process.version}, ${os.cpus().length} CPU's, ${os.platform()}`);

const lat = [], viewLat = []; const errCodes = {}; let errors = 0, dupOk = 0, dupBad = 0, lost = 0;
for (let r = 0; r < ROUNDS; r++) {
  const act = async a => { const res = await post('/api/staff/live', { action: a, questionId: qs[r], seq: hv.live.seq }, S); if (res.live) hv.live.seq = res.live.seq; else throw new Error(JSON.stringify(res)); };
  await act('prepare'); await act('open');
  // wacht tot de vraag zichtbaar is bij alle clients (broadcast op open_at)
  const tOpen = Date.now();
  while (socks.some(s => !(s.last?.question?.id === qs[r] && s.last.question.visible))) await sleep(5);
  viewLat.push(Date.now() - tOpen - 500);
  // reconnect-scenario: 10% verbreekt en verbindt opnieuw vlak voor het antwoorden
  if (r === 2) { for (let i = 0; i < N; i += 10) { socks[i].disconnect(); socks[i] = await mk(tokens[i]); } }
  await Promise.all(socks.map((s, i) => new Promise(res => {
    const t0 = performance.now(); const answer = (i + r) % 4;
    s.timeout(5000).emit('submit', { questionId: qs[r], answer }, (err, a) => {
      if (err || !a?.ok) { errors++; errCodes[err ? 'timeout' : a.code] = (errCodes[err ? 'timeout' : a.code] || 0) + 1; return res(); }
      lat.push(performance.now() - t0);
      // dubbele tap direct erachteraan
      s.timeout(5000).emit('submit', { questionId: qs[r], answer: (answer + 1) % 4 }, (e2, b) => { if (!e2 && b?.ok && b.duplicate) dupOk++; else dupBad++; res(); });
    });
  })));
  await act('close'); await act('reveal'); await act('score');
  const subs = app.bamigo.db.get('SELECT COUNT(*) n FROM submissions WHERE question_id = ?', qs[r]).n;
  if (subs !== N) lost += N - subs;
}
const db = app.bamigo.db;
const dupSubs = db.get('SELECT COUNT(*) n FROM (SELECT question_id, owner_key, COUNT(*) c FROM submissions GROUP BY 1,2 HAVING c > 1)').n;
const dupScores = db.get("SELECT COUNT(*) n FROM (SELECT source_key, COUNT(*) c FROM score_events WHERE voided_at IS NULL GROUP BY 1 HAVING c > 1)").n;
lat.sort((a, b) => a - b);
const pct = p => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))]?.toFixed(1);
const report = {
  deelnemers: N, foutcodes: errCodes, vragen: ROUNDS, inzendingen: lat.length, fouten: errors, foutpercentage: ((errors / (N * ROUNDS)) * 100).toFixed(2) + '%',
  ontvangstbevestiging_ms: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: lat.at(-1)?.toFixed(1) },
  vraag_zichtbaar_bij_alle_clients_na_start_ms: { gemiddeld: (viewLat.reduce((a, b) => a + b, 0) / viewLat.length).toFixed(0), max: Math.max(...viewLat) },
  dubbele_taps_correct_afgevangen: dupOk, dubbele_taps_fout: dupBad, ontbrekende_inzendingen: lost, dubbele_inzendingen_in_db: dupSubs, dubbele_scoreregels: dupScores,
};
console.log(JSON.stringify(report, null, 2));
for (const s of socks) s.disconnect(); hostSock.disconnect();
await app.close(); fs.rmSync(dir, { recursive: true, force: true });
process.exit(errors || lost || dupSubs || dupScores || dupBad ? 1 : 0);
