// HTTP + realtime server. buildApp() wordt ook door de tests gebruikt.
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { Server as IOServer } from 'socket.io';
import QRCode from 'qrcode';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb, id, json } from './db.js';
import { HttpError, staffByToken, playerByToken, can, deny, bad, notFound, createGrant, safeEqual, ROLES } from './auth.js';
import * as C from './content.js';
import { Live } from './live.js';
import { playerView, displayView, staffView } from './views.js';
import { exportResults, exportPack, importPack, emergencyPack } from './exporting.js';
import { seedDemo } from './seed-demo.js';
import * as M from './modules.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const MEDIA_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/wav': 'wav', 'video/mp4': 'mp4' };
const MAX_UPLOAD = 15 * 1024 * 1024;

export async function buildApp({ dbFile = process.env.BAMIGO_DB || path.join(root, 'data', 'bamigo.db'), mediaDir = process.env.BAMIGO_MEDIA || path.join(root, 'data', 'media'),
  adminPassword = process.env.BAMIGO_ADMIN_PASSWORD, publicUrl = process.env.PUBLIC_URL, logger = false, clock, timers = true } = {}) {
  const db = openDb(dbFile);
  fs.mkdirSync(mediaDir, { recursive: true });
  if (!adminPassword) {
    adminPassword = crypto.randomBytes(9).toString('base64url');
    console.log(`\n  Geen BAMIGO_ADMIN_PASSWORD ingesteld. Tijdelijk beheerwachtwoord: ${adminPassword}\n`);
  }

  const app = Fastify({ logger, trustProxy: true, bodyLimit: 1024 * 1024 });
  const online = new Map(); // eventId -> Map(participantId -> aantal verbindingen)
  const onlineSet = eid => new Set(online.get(eid)?.keys() ?? []);
  let io;
  const pending = new Map();
  const live = new Live({ db, clock, schedule: timers, notify: eid => {
    if (pending.has(eid)) return;
    pending.set(eid, setTimeout(() => { pending.delete(eid); broadcast(eid); }, 25));
  } });

  const baseUrl = req => publicUrl || `${req?.protocol || 'http'}://${req?.headers?.host || 'localhost'}`;
  const joinUrl = (req, code) => `${baseUrl(req)}/speel?code=${code}`;

  // ---------- beveiliging ----------
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD, files: 1 } });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, code: err.code });
    if (err.statusCode === 429) return reply.code(429).send({ error: 'Even rustig aan: te veel verzoeken.', code: 'rate_limited' });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message, code: err.code });
    req.log.error(err); console.error(err);
    reply.code(500).send({ error: 'Er ging iets mis op de server.', code: 'server_error' });
  });

  // Mislukte codepogingen per IP beperken (code raden). Ruim gekozen: op een feest delen alle telefoons één wifi-IP.
  // 30 fouten per 10 min tegen ~10^9 mogelijke codes maakt raden kansloos.
  const badCodes = new Map();
  const checkCodeLimit = ip => { const e = badCodes.get(ip); if (e && e.n >= 30 && Date.now() - e.t < 10 * 60e3) throw new HttpError(429, 'Te veel foute codes. Probeer het over een paar minuten opnieuw.', 'rate_limited'); };
  const noteBadCode = ip => { const e = badCodes.get(ip); if (!e || Date.now() - e.t > 10 * 60e3) badCodes.set(ip, { n: 1, t: Date.now() }); else e.n++; };

  // ---------- auth helpers ----------
  const tokenFrom = (req, h) => req.headers[h] || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
  const staff = (req, perm) => {
    const s = staffByToken(db, tokenFrom(req, 'x-staff-token'));
    if (!s) throw new HttpError(401, 'Ongeldige of verlopen beheerlink.', 'unauthorized');
    if (perm && !can(s.role, perm)) deny('Je rol (' + ROLES[s.role].label + ') mag dit niet.');
    return s;
  };
  const player = req => {
    const p = playerByToken(db, tokenFrom(req, 'x-player-token'));
    if (!p) throw new HttpError(401, 'Je sessie is niet (meer) geldig. Meld je opnieuw aan.', 'unauthorized');
    return p;
  };
  const actorOf = s => `${s.role}:${s.grant.id}`;
  const touch = eid => { db.run('UPDATE events SET updated_at = ? WHERE id = ?', Date.now(), eid); live.notify(eid); };

  // ---------- publiek ----------
  app.get('/api/health', async () => ({ ok: true, time: Date.now() }));
  app.get('/api/time', async () => ({ now: Date.now() }));

  app.get('/api/join/:code', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req) => {
    checkCodeLimit(req.ip);
    const code = String(req.params.code).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const ev = db.get('SELECT id, name, subtitle, mode, status, is_demo, settings FROM events WHERE join_code = ?', code);
    if (!ev) { noteBadCode(req.ip); notFound('Onbekende code.'); }
    const teams = db.all('SELECT id, name FROM teams WHERE event_id = ? ORDER BY sort, name', ev.id);
    const open = db.all('SELECT name FROM participants WHERE event_id = ? AND token_hash IS NULL ORDER BY name', ev.id).map(r => r.name);
    return { name: ev.name, subtitle: ev.subtitle, mode: ev.mode, isDemo: !!ev.is_demo, status: ev.status, teams, expectedNames: open, selfTeam: json(ev.settings, {}).selfTeam !== false };
  });

  app.post('/api/join', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req) => {
    checkCodeLimit(req.ip);
    try { const r = C.joinEvent(db, req.body || {}); touch(r.eventId); return { token: r.token }; }
    catch (e) { if (e.code === 'bad_code') noteBadCode(req.ip); throw e; }
  });

  app.get('/api/qr.svg', async (req, reply) => {
    const code = String(req.query.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
    if (!code) bad('Code ontbreekt');
    const svg = await QRCode.toString(joinUrl(req, code), { type: 'svg', margin: 1, color: { dark: '#151515', light: '#F4E8CF' }, errorCorrectionLevel: 'M' });
    reply.header('Cache-Control', 'public, max-age=300').type('image/svg+xml').send(svg);
  });

  const checkAdmin = req => { if (!safeEqual(req.headers['x-admin-password'] || '', adminPassword)) throw new HttpError(401, 'Onjuist beheerwachtwoord.', 'unauthorized'); };
  app.post('/api/events', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    checkAdmin(req);
    const r = C.createEvent(db, req.body || {});
    return { eventId: r.event.id, joinCode: r.event.join_code, ownerToken: r.ownerToken, displayToken: r.displayToken };
  });
  app.post('/api/demo', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    checkAdmin(req);
    return seedDemo(db);
  });

  // ---------- speler ----------
  app.get('/api/player/view', async req => { const p = player(req); return playerView(live, p, onlineSet(p.event.id)); });
  app.post('/api/player/submit', async req => {
    const p = player(req);
    const r = live.submit(p.event.id, p.participant, req.body || {});
    return { ok: true, duplicate: r.duplicate, receivedAt: r.submission.received_at };
  });
  app.post('/api/player/captain', async req => {
    const p = player(req);
    live.setCaptain(p.event.id, 'player:' + p.participant.id, String(req.body?.participantId || ''), { byParticipant: p.participant.id });
    return { ok: true };
  });
  app.post('/api/player/team', async req => {
    const p = player(req);
    if (json(p.event.settings, {}).selfTeam === false) deny('De organisatie deelt de teams in.');
    if (live.membership(p.participant.id)) deny('Je zit al in een team. Vraag de host om te wisselen.');
    C.setTeam(db, p.event.id, p.participant.id, String(req.body?.teamId || '')); C.claimCaptainIfAbsent(db, p.participant.id);
    touch(p.event.id); return { ok: true };
  });

  // ---------- voorbereiding (speler) ----------
  const myTeam = p => live.membership(p.participant.id) || deny('Je zit nog niet in een team.');
  app.post('/api/player/vote', async req => { const p = player(req); M.castVote(db, p.event.id, p.participant, req.body || {}); touch(p.event.id); return { ok: true }; });
  app.post('/api/player/profile', async req => {
    const p = player(req); const b = req.body || {};
    const prof = { ...json(p.participant.profile, {}), story: String(b.story ?? '').slice(0, 1000), limits: String(b.limits ?? '').slice(0, 500), done: !!b.done };
    db.run('UPDATE participants SET profile = ? WHERE id = ?', JSON.stringify(prof), p.participant.id);
    touch(p.event.id); return { ok: true };
  });
  app.post('/api/player/shot', async req => {
    const p = player(req); const m = myTeam(p);
    if (json(p.event.settings, {}).drinks === false) deny('Drankonderdelen staan uit voor deze avond.');
    if (db.get("SELECT 1 FROM questions WHERE event_id = ? AND type = 'shot' AND locked_at IS NOT NULL", p.event.id)) deny('De shotronde is al begonnen; wijzigen kan niet meer.');
    M.saveShot(db, p.event.id, m.team_id, req.body || {}, p.participant.name); touch(p.event.id); return { ok: true };
  });
  app.post('/api/player/evidence', async req => {
    const p = player(req); const m = myTeam(p); const b = req.body || {};
    M.saveEvidence(db, p.event.id, m.team_id, String(b.missionId || ''), { value: b.value, note: b.note }, p.participant.name); touch(p.event.id); return { ok: true };
  });
  app.post('/api/player/evidence/photo', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async req => {
    const p = player(req); const m = myTeam(p);
    const missionId = String(req.query.missionId || '');
    db.get('SELECT 1 FROM missions WHERE id = ? AND event_id = ?', missionId, p.event.id) || notFound('Missie niet gevonden');
    const mid = await storeUpload(req, p.event.id, 'player:' + p.participant.id, { imagesOnly: true, sensitive: true });
    M.saveEvidence(db, p.event.id, m.team_id, missionId, { mediaId: mid }, p.participant.name);
    touch(p.event.id); return { ok: true };
  });

  // ---------- staf ----------
  app.get('/api/staff/view', async req => { const s = staff(req); return staffView(live, s, onlineSet(s.event.id), joinUrl(req, s.event.join_code)); });
  app.patch('/api/staff/event', async req => { const s = staff(req, 'event.manage'); C.updateEvent(db, s.event.id, req.body || {}); touch(s.event.id); return { ok: true }; });

  app.post('/api/staff/teams', async req => { const s = staff(req, 'people.write'); const tid = C.upsertTeam(db, s.event.id, req.body || {}); touch(s.event.id); return { id: tid }; });
  app.delete('/api/staff/teams/:id', async req => { const s = staff(req, 'people.write'); C.deleteTeam(db, s.event.id, req.params.id); touch(s.event.id); return { ok: true }; });
  app.post('/api/staff/participants', async req => { const s = staff(req, 'people.write'); const pid = C.upsertParticipant(db, s.event.id, req.body || {}); touch(s.event.id); return { id: pid }; });
  app.delete('/api/staff/participants/:id', async req => { const s = staff(req, 'people.write'); C.deleteParticipant(db, s.event.id, req.params.id); touch(s.event.id); return { ok: true }; });
  app.post('/api/staff/participants/:id/link', async req => {
    const s = staff(req, 'people.write');
    const token = C.issueParticipantLink(db, s.event.id, req.params.id);
    for (const sock of io.sockets.sockets.values()) if (sock.data.pid === req.params.id) sock.disconnect(true);
    live.audit(s.event.id, actorOf(s), 'participant_link', { participantId: req.params.id });
    touch(s.event.id);
    return { url: `${baseUrl(req)}/speel#t=${token}` };
  });
  app.post('/api/staff/captain', async req => { const s = staff(req, 'people.write'); live.setCaptain(s.event.id, actorOf(s), String(req.body?.participantId || '')); return { ok: true }; });

  app.post('/api/staff/rounds', async req => { const s = staff(req, 'content.write'); const rid = C.upsertRound(db, s.event.id, req.body || {}); touch(s.event.id); return { id: rid }; });
  app.delete('/api/staff/rounds/:id', async req => { const s = staff(req, 'content.write'); C.deleteRound(db, s.event.id, req.params.id); touch(s.event.id); return { ok: true }; });
  app.post('/api/staff/reorder', async req => { const s = staff(req, 'content.write'); C.reorder(db, s.event.id, req.body?.table, req.body?.ids); touch(s.event.id); return { ok: true }; });
  app.post('/api/staff/questions', async req => { const s = staff(req, 'content.write'); const qid = C.upsertQuestion(db, s.event.id, req.body || {}); touch(s.event.id); return { id: qid }; });
  app.delete('/api/staff/questions/:id', async req => { const s = staff(req, 'content.write'); C.deleteQuestion(db, s.event.id, req.params.id); touch(s.event.id); return { ok: true }; });

  app.post('/api/staff/live', async req => {
    const s = staff(req, 'live.control');
    const body = req.body || {};
    if (body.action === 'next_question') {
      const qid = live.nextQuestionId(s.event.id); if (!qid) bad('Er is geen volgende vraag.');
      return { live: live.action(s.event.id, actorOf(s), { action: 'prepare', questionId: qid, seq: body.seq }) };
    }
    if (body.action === 'prev_question') {
      const qid = live.prevQuestionId(s.event.id); if (!qid) bad('Er is geen vorige vraag.');
      return { live: live.action(s.event.id, actorOf(s), { action: 'goto', questionId: qid, seq: body.seq }) };
    }
    return { live: live.action(s.event.id, actorOf(s), body) };
  });
  app.post('/api/staff/judge', async req => { const s = staff(req, 'live.control'); live.judge(s.event.id, actorOf(s), req.body?.submissionId, req.body?.verdict); return { ok: true }; });
  app.post('/api/staff/scores', async req => { const s = staff(req, 'scores.write'); return live.adjust(s.event.id, actorOf(s), req.body || {}); });
  app.post('/api/staff/scores/:id/void', async req => { const s = staff(req, 'scores.write'); live.voidScoreEvent(s.event.id, actorOf(s), req.params.id, req.body?.reason); return { ok: true }; });

  app.post('/api/staff/grants', async req => {
    const s = staff(req, 'roles.manage');
    const role = req.body?.role;
    if (role === 'owner') deny('Er is maar één eigenaarslink.');
    const g = createGrant(db, s.event.id, role, req.body?.label);
    live.audit(s.event.id, actorOf(s), 'grant', { role, id: g.id });
    return { id: g.id, url: `${baseUrl(req)}/${role === 'display' ? 'tv' : 'beheer'}#k=${g.token}` };
  });
  app.post('/api/staff/grants/:id/revoke', async req => {
    const s = staff(req, 'roles.manage');
    const g = db.get('SELECT * FROM role_grants WHERE id = ? AND event_id = ?', req.params.id, s.event.id) || notFound();
    if (g.id === s.grant.id) bad('Je kunt je eigen link niet intrekken.');
    db.run('UPDATE role_grants SET revoked = 1 WHERE id = ?', g.id);
    for (const sock of io.sockets.sockets.values()) if (sock.data.grantId === g.id) sock.disconnect(true);
    touch(s.event.id); return { ok: true };
  });

  app.post('/api/staff/duplicate', async req => {
    const s = staff(req, 'event.manage');
    const r = C.duplicateEvent(db, s.event.id, req.body || {});
    return { eventId: r.event.id, url: `${baseUrl(req)}/beheer#k=${r.ownerToken}`, tvUrl: `${baseUrl(req)}/tv#k=${r.displayToken}` };
  });
  app.get('/api/staff/export/results', async req => { const s = staff(req, 'scores.write'); return exportResults(db, live, s.event.id); });
  app.get('/api/staff/export/pack', async req => { const s = staff(req, 'content.read'); return exportPack(db, s.event.id); });
  app.post('/api/staff/import/pack', async req => { const s = staff(req, 'content.write'); const r = importPack(db, s.event.id, req.body); touch(s.event.id); return r; });
  app.get('/api/staff/emergency', async (req, reply) => { const s = staff(req, 'content.read'); reply.type('text/html; charset=utf-8').send(emergencyPack(db, s.event.id)); });

  // ---------- shots, missies ----------
  app.post('/api/staff/shots/:id', async req => { const s = staff(req, 'secrets.read'); M.adminShot(db, s.event.id, req.params.id, req.body || {}); touch(s.event.id); return { ok: true }; });
  app.post('/api/staff/shots/team/:teamId', async req => { const s = staff(req, 'secrets.read'); M.saveShot(db, s.event.id, req.params.teamId, req.body || {}, s.grant.label); touch(s.event.id); return { ok: true }; });
  app.post('/api/staff/missions', async req => { const s = staff(req, 'content.write'); const mid = M.upsertMission(db, s.event.id, req.body || {}); touch(s.event.id); return { id: mid }; });
  app.delete('/api/staff/missions/:id', async req => {
    const s = staff(req, 'content.write');
    if (!db.run('DELETE FROM missions WHERE id = ? AND event_id = ?', req.params.id, s.event.id).changes) notFound();
    db.run("UPDATE score_events SET voided_at = ?, voided_reason = 'missie verwijderd' WHERE event_id = ? AND source_key LIKE ? AND voided_at IS NULL", Date.now(), s.event.id, `m:${req.params.id}:%`);
    touch(s.event.id); return { ok: true };
  });
  app.post('/api/staff/evidence/check', async req => { const s = staff(req, 'live.control'); const b = req.body || {}; M.checkEvidence(db, s.event.id, String(b.missionId), String(b.teamId), b); touch(s.event.id); return { ok: true }; });
  app.post('/api/staff/missions/:id/score', async req => { const s = staff(req, 'scores.write'); return { results: live.scoreMission(s.event.id, actorOf(s), req.params.id) }; });

  // ---------- media ----------
  async function storeUpload(req, eventId, by, { imagesOnly = false, sensitive = false } = {}) {
    const file = await req.file();
    if (!file) bad('Geen bestand');
    const ext = MEDIA_TYPES[file.mimetype];
    if (!ext || (imagesOnly && !file.mimetype.startsWith('image/'))) bad(imagesOnly ? 'Alleen foto’s (jpg, png, webp).' : 'Bestandstype niet toegestaan (jpg, png, webp, gif, mp3, m4a, wav, mp4).');
    const buf = await file.toBuffer();
    if (file.file.truncated) bad('Bestand is te groot (max 15 MB).');
    if (!sniff(buf, file.mimetype)) bad('Bestandsinhoud klopt niet met het type.');
    const mid = id('m_'); const key = `${eventId}/${mid}.${ext}`;
    fs.mkdirSync(path.join(mediaDir, eventId), { recursive: true });
    fs.writeFileSync(path.join(mediaDir, key), buf);
    db.run('INSERT INTO media (id, event_id, filename, mime, size, storage_key, sensitive, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      mid, eventId, String(file.filename).slice(0, 120), file.mimetype, buf.length, key, sensitive ? 1 : 0, by, Date.now());
    return mid;
  }
  app.post('/api/staff/media', async req => {
    const s = staff(req, 'content.write');
    return { id: await storeUpload(req, s.event.id, actorOf(s), { sensitive: !!req.query.sensitive }) };
  });
  // Media alleen via header-token. Spelers/tv: alleen media van de actieve, geopende vraag.
  app.get('/api/media/:id', async (req, reply) => {
    const m = db.get('SELECT * FROM media WHERE id = ?', req.params.id) || notFound();
    const st = staffByToken(db, tokenFrom(req, 'x-staff-token'));
    let ok = false;
    const evidenceOf = db.get('SELECT team_id FROM evidence WHERE media_id = ?', m.id);
    if (st && st.event.id === m.event_id) ok = can(st.role, 'content.read') || (!!evidenceOf && can(st.role, 'live.control')) || (!m.sensitive && (can(st.role, 'display') || can(st.role, 'live.prompts')) && mediaIsLive(m.id, m.event_id));
    if (!ok) {
      const p = playerByToken(db, tokenFrom(req, 'x-player-token'));
      if (p && p.event.id === m.event_id) ok = evidenceOf ? live.membership(p.participant.id)?.team_id === evidenceOf.team_id : (!m.sensitive && mediaIsLive(m.id, m.event_id));
    }
    if (!ok) deny();
    reply.header('Cache-Control', 'private, no-store').type(m.mime).send(fs.createReadStream(path.join(mediaDir, m.storage_key)));
  });
  function mediaIsLive(mid, eid) {
    const s = live.state(eid);
    if (!s.question_id || !['open', 'closed', 'revealed', 'scored'].includes(s.phase) || (s.phase === 'open' && live.clock() < s.open_at)) return false;
    return !!db.get('SELECT 1 FROM questions WHERE id = ? AND media_id = ?', s.question_id, mid);
  }

  // ---------- statische bestanden ----------
  await app.register(fastifyStatic, { root: path.join(root, 'public'), prefix: '/', index: false, wildcard: true });
  await app.register(fastifyStatic, { root: path.join(root, 'node_modules', '@fontsource'), prefix: '/fonts/', decorateReply: false });
  const page = f => (req, reply) => reply.type('text/html; charset=utf-8').send(fs.readFileSync(path.join(root, 'public', f)));
  app.get('/', page('index.html'));
  app.get('/speel', page('speel.html'));
  app.get('/tv', page('tv.html'));
  app.get('/beheer', page('beheer.html'));

  // ---------- realtime ----------
  function viewFor(sock) {
    const d = sock.data;
    if (d.kind === 'player') {
      const p = playerByToken(db, d.token); if (!p) return null;
      return playerView(live, p, onlineSet(p.event.id));
    }
    const s = staffByToken(db, d.token); if (!s) return null;
    return s.role === 'display' ? displayView(live, s.event, onlineSet(s.event.id), joinUrl(d.req, s.event.join_code)) : staffView(live, s, onlineSet(s.event.id), joinUrl(d.req, s.event.join_code));
  }
  function broadcast(eid) {
    if (!io) return;
    for (const sock of io.sockets.adapter.rooms.get('ev:' + eid) ?? []) {
      const so = io.sockets.sockets.get(sock); if (!so) continue;
      try { const v = viewFor(so); if (v) so.emit('state', v); else so.disconnect(true); } catch (e) { console.error(e); }
    }
  }

  app.decorate('bamigo', { db, live, broadcast, adminPassword });

  app.addHook('onReady', async () => {
    io = new IOServer(app.server, { cors: { origin: false }, serveClient: true, pingInterval: 10000, pingTimeout: 8000, maxHttpBufferSize: 64 * 1024 });
    io.use((sock, next) => {
      const { kind, token } = sock.handshake.auth || {};
      const host = sock.handshake.headers['x-forwarded-host'] || sock.handshake.headers.host;
      sock.data.req = { protocol: sock.handshake.headers['x-forwarded-proto'] || (sock.handshake.secure ? 'https' : 'http'), headers: { host } };
      if (kind === 'player') {
        const p = playerByToken(db, token); if (!p) return next(new Error('unauthorized'));
        Object.assign(sock.data, { kind, token, eid: p.event.id, pid: p.participant.id });
      } else if (kind === 'staff') {
        const s = staffByToken(db, token); if (!s) return next(new Error('unauthorized'));
        Object.assign(sock.data, { kind, token, eid: s.event.id, grantId: s.grant.id, role: s.role });
      } else return next(new Error('unauthorized'));
      next();
    });
    io.on('connection', sock => {
      const { eid, pid } = sock.data;
      sock.join('ev:' + eid);
      if (pid) {
        const m = online.get(eid) ?? new Map(); online.set(eid, m); m.set(pid, (m.get(pid) ?? 0) + 1);
        C.markJoined(db, pid); C.claimCaptainIfAbsent(db, pid);
      }
      live.notify(eid);
      const v = viewFor(sock); if (v) sock.emit('state', v);
      sock.on('time', (t0, ack) => typeof ack === 'function' && ack({ t0, now: live.clock() }));
      sock.on('refresh', (_, ack) => { const v = viewFor(sock); typeof ack === 'function' && ack(v); });
      sock.on('submit', (body, ack) => {
        if (typeof ack !== 'function') return;
        try {
          const p = playerByToken(db, sock.data.token); if (!p) throw new HttpError(401, 'Sessie ongeldig', 'unauthorized');
          const r = live.submit(p.event.id, p.participant, body || {});
          ack({ ok: true, duplicate: r.duplicate, receivedAt: r.submission.received_at, clientId: body?.clientId });
        } catch (e) { ack({ ok: false, error: e instanceof HttpError ? e.message : 'Serverfout', code: e.code || 'error', clientId: body?.clientId }); if (!(e instanceof HttpError)) console.error(e); }
      });
      sock.on('advise', (body, ack) => {
        if (typeof ack !== 'function') return;
        try {
          const p = playerByToken(db, sock.data.token); if (!p) throw new HttpError(401, 'Sessie ongeldig', 'unauthorized');
          live.advise(p.event.id, p.participant, body || {});
          ack({ ok: true });
        } catch (e) { ack({ ok: false, error: e instanceof HttpError ? e.message : 'Serverfout', code: e.code || 'error' }); if (!(e instanceof HttpError)) console.error(e); }
      });
      sock.on('disconnect', () => {
        if (pid) { const m = online.get(eid); if (m) { const n = (m.get(pid) ?? 1) - 1; if (n <= 0) m.delete(pid); else m.set(pid, n); } }
        live.notify(eid);
      });
    });
    live.resumeAll();
  });
  app.addHook('onClose', async () => { io?.close(); for (const t of live.timers.values()) clearTimeout(t); db.close(); });
  return app;
}

function sniff(buf, mime) {
  const h = buf.subarray(0, 12);
  const hex = h.toString('hex');
  if (mime === 'image/jpeg') return hex.startsWith('ffd8ff');
  if (mime === 'image/png') return hex.startsWith('89504e47');
  if (mime === 'image/gif') return h.toString('ascii', 0, 3) === 'GIF';
  if (mime === 'image/webp') return h.toString('ascii', 0, 4) === 'RIFF' && h.toString('ascii', 8, 12) === 'WEBP';
  if (mime === 'audio/wav') return h.toString('ascii', 0, 4) === 'RIFF';
  if (mime === 'audio/mpeg') return hex.startsWith('494433') || (h[0] === 0xff && (h[1] & 0xe0) === 0xe0);
  if (mime === 'audio/mp4' || mime === 'audio/x-m4a' || mime === 'video/mp4') return h.toString('ascii', 4, 8) === 'ftyp';
  return false;
}
