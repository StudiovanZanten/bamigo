// Beheer van evenementen, teams, deelnemers, rondes en vragen.
import crypto from 'node:crypto';
import { id, json } from './db.js';
import { bad, notFound, HttpError, createGrant, newToken, hashToken } from './auth.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // geen 0/O/1/I
export function makeJoinCode(len = 6) {
  const bytes = crypto.randomBytes(len);
  return Array.from(bytes, b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

const str = (v, max = 500) => (v == null ? null : String(v).trim().slice(0, max) || null);
const int = (v, min, max, dflt) => { const n = Number(v); return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : dflt; };

export const ROUND_KINDS = ['quiz', 'brocode', 'ranking', 'kompaan', 'shots', 'missions', 'dragons', 'search', 'bluff', 'lightning', 'final', 'break', 'intro'];
export const QUESTION_TYPES = ['mc', 'tf', 'open', 'number', 'order', 'match', 'ranking'];

export const DEFAULT_SETTINGS = {
  theme: 'koper', countdownMs: 3000, humor: true, adultTopics: true, drinks: true, sound: true, oneliners: true,
  closestScale: [5, 4, 3, 2, 1], lightningTeamAverage: false, selfVote: false,
};

export function createEvent(db, { name, subtitle, startsAt, mode = 'teams', isDemo = false, settings = {}, durationTarget = 110, durationMax = 120 }) {
  if (!str(name)) bad('Geef de avond een naam.');
  const t = Date.now();
  const ev = { id: id('ev_'), name: str(name, 120), join_code: uniqueCode(db) };
  db.tx(() => {
    db.run(`INSERT INTO events (id, name, subtitle, starts_at, duration_target, duration_max, join_code, mode, settings, is_demo, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, ev.id, ev.name, str(subtitle, 200), str(startsAt, 40), int(durationTarget, 10, 600, 110), int(durationMax, 10, 600, 120),
      ev.join_code, mode === 'individual' ? 'individual' : 'teams', JSON.stringify({ ...DEFAULT_SETTINGS, ...settings }), isDemo ? 1 : 0, t, t);
  });
  const owner = createGrant(db, ev.id, 'owner', 'Eigenaar');
  const display = createGrant(db, ev.id, 'display', 'TV-scherm');
  return { event: db.get('SELECT * FROM events WHERE id = ?', ev.id), ownerToken: owner.token, displayToken: display.token };
}

function uniqueCode(db) {
  for (let i = 0; i < 20; i++) { const c = makeJoinCode(); if (!db.get('SELECT 1 FROM events WHERE join_code = ?', c)) return c; }
  throw new Error('Kon geen unieke code maken');
}

export function updateEvent(db, eventId, body) {
  const ev = db.get('SELECT * FROM events WHERE id = ?', eventId) || notFound();
  const settings = { ...json(ev.settings, {}), ...(body.settings && typeof body.settings === 'object' ? body.settings : {}) };
  db.run(`UPDATE events SET name=?, subtitle=?, starts_at=?, duration_target=?, duration_max=?, mode=?, status=?, settings=?, updated_at=? WHERE id=?`,
    str(body.name, 120) ?? ev.name, body.subtitle !== undefined ? str(body.subtitle, 200) : ev.subtitle, body.startsAt !== undefined ? str(body.startsAt, 40) : ev.starts_at,
    int(body.durationTarget, 10, 600, ev.duration_target), int(body.durationMax, 10, 600, ev.duration_max),
    ['teams', 'individual'].includes(body.mode) ? body.mode : ev.mode, ['draft', 'live', 'finished', 'archived'].includes(body.status) ? body.status : ev.status,
    JSON.stringify(settings), Date.now(), eventId);
}

// ---------- teams & deelnemers ----------
export function upsertTeam(db, eventId, body) {
  const t = Date.now();
  if (body.id) {
    const tm = db.get('SELECT * FROM teams WHERE id = ? AND event_id = ?', body.id, eventId) || notFound('Team niet gevonden');
    db.run('UPDATE teams SET name=?, color=?, outfit=?, sort=? WHERE id=?', str(body.name, 60) ?? tm.name, str(body.color, 20), str(body.outfit, 200), int(body.sort, 0, 9999, tm.sort), tm.id);
    return tm.id;
  }
  if (!str(body.name)) bad('Teamnaam is verplicht.');
  const tid = id('t_');
  const sort = db.get('SELECT COALESCE(MAX(sort),0)+1 AS s FROM teams WHERE event_id = ?', eventId).s;
  db.run('INSERT INTO teams (id, event_id, name, color, outfit, sort, created_at) VALUES (?,?,?,?,?,?,?)', tid, eventId, str(body.name, 60), str(body.color, 20), str(body.outfit, 200), sort, t);
  return tid;
}

export function deleteTeam(db, eventId, teamId) {
  const r = db.run('DELETE FROM teams WHERE id = ? AND event_id = ?', teamId, eventId);
  if (!r.changes) notFound('Team niet gevonden');
}

/** Voeg deelnemer toe (door organisator) of wijzig naam/team. */
export function upsertParticipant(db, eventId, body) {
  return db.tx(() => {
    let pid = body.id;
    if (pid) {
      db.get('SELECT 1 FROM participants WHERE id = ? AND event_id = ?', pid, eventId) || notFound('Deelnemer niet gevonden');
      if (str(body.name)) {
        if (db.get('SELECT 1 FROM participants WHERE event_id = ? AND name = ? COLLATE NOCASE AND id <> ?', eventId, str(body.name, 40), pid)) bad('Die naam bestaat al.');
        db.run('UPDATE participants SET name = ? WHERE id = ?', str(body.name, 40), pid);
      }
    } else {
      const name = str(body.name, 40); if (!name) bad('Naam is verplicht.');
      if (db.get('SELECT 1 FROM participants WHERE event_id = ? AND name = ? COLLATE NOCASE', eventId, name)) bad('Die naam bestaat al.');
      pid = id('p_');
      db.run('INSERT INTO participants (id, event_id, name, created_at) VALUES (?,?,?,?)', pid, eventId, name, Date.now());
    }
    if (body.teamId !== undefined) setTeam(db, eventId, pid, body.teamId);
    return pid;
  });
}

export function setTeam(db, eventId, pid, teamId) {
  if (!teamId) { db.run('DELETE FROM memberships WHERE participant_id = ?', pid); return; }
  db.get('SELECT 1 FROM teams WHERE id = ? AND event_id = ?', teamId, eventId) || notFound('Team niet gevonden');
  const cur = db.get('SELECT * FROM memberships WHERE participant_id = ?', pid);
  if (cur?.team_id === teamId) return;
  db.run('DELETE FROM memberships WHERE participant_id = ?', pid);
  const hasCaptain = db.get('SELECT 1 FROM memberships WHERE team_id = ? AND is_captain = 1', teamId);
  db.run('INSERT INTO memberships (participant_id, team_id, is_captain) VALUES (?,?,?)', pid, teamId, hasCaptain ? 0 : 1);
}

export function deleteParticipant(db, eventId, pid) {
  db.tx(() => {
    const m = db.get('SELECT * FROM memberships WHERE participant_id = ?', pid);
    const r = db.run('DELETE FROM participants WHERE id = ? AND event_id = ?', pid, eventId);
    if (!r.changes) notFound('Deelnemer niet gevonden');
    if (m?.is_captain) promoteCaptain(db, m.team_id);
  });
}

function promoteCaptain(db, teamId) {
  const next = db.get('SELECT participant_id FROM memberships WHERE team_id = ? ORDER BY participant_id LIMIT 1', teamId);
  if (next) db.run('UPDATE memberships SET is_captain = 1 WHERE participant_id = ?', next.participant_id);
}

/** Maak een persoonlijke deelnamelink (vervangt eerdere sessie van deze deelnemer). */
export function issueParticipantLink(db, eventId, pid) {
  db.get('SELECT 1 FROM participants WHERE id = ? AND event_id = ?', pid, eventId) || notFound('Deelnemer niet gevonden');
  const token = newToken();
  db.run('UPDATE participants SET token_hash = ? WHERE id = ?', hashToken(token), pid);
  return token;
}

/**
 * Aanmelden met code + naam. Bestaat de naam al en is die nog niet geclaimd, dan claim je hem.
 * Is hij al geclaimd, dan kan alleen het oorspronkelijke apparaat (of een nieuwe link van de host) verder.
 */
export function joinEvent(db, { code, name, teamId }) {
  const ev = db.get('SELECT * FROM events WHERE join_code = ?', String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''));
  if (!ev) throw new HttpError(404, 'Onbekende code.', 'bad_code');
  if (ev.status === 'archived' || ev.status === 'finished') throw new HttpError(410, 'Deze avond is afgelopen.', 'finished');
  const nm = str(name, 40); if (!nm) bad('Vul je naam in.');
  return db.tx(() => {
    let p = db.get('SELECT * FROM participants WHERE event_id = ? AND name = ? COLLATE NOCASE', ev.id, nm);
    if (p && p.token_hash) throw new HttpError(409, 'Deze naam is al aangemeld op een ander apparaat. Vraag de host om een nieuwe link.', 'name_taken');
    const token = newToken(); const t = Date.now();
    if (!p) {
      const pid = id('p_');
      db.run('INSERT INTO participants (id, event_id, name, token_hash, joined_at, last_seen, created_at) VALUES (?,?,?,?,?,?,?)', pid, ev.id, nm, hashToken(token), t, t, t);
      p = { id: pid };
    } else {
      db.run('UPDATE participants SET token_hash = ?, joined_at = COALESCE(joined_at, ?), last_seen = ? WHERE id = ?', hashToken(token), t, t, p.id);
    }
    const hasTeam = db.get('SELECT 1 FROM memberships WHERE participant_id = ?', p.id);
    if (!hasTeam && teamId) setTeam(db, ev.id, p.id, teamId);
    return { token, participantId: p.id, eventId: ev.id };
  });
}

export function markJoined(db, pid) {
  db.run('UPDATE participants SET joined_at = COALESCE(joined_at, ?), last_seen = ? WHERE id = ?', Date.now(), Date.now(), pid);
}

// ---------- rondes & vragen ----------
export function upsertRound(db, eventId, body) {
  const kind = ROUND_KINDS.includes(body.kind) ? body.kind : 'quiz';
  if (body.id) {
    const r = db.get('SELECT * FROM rounds WHERE id = ? AND event_id = ?', body.id, eventId) || notFound('Ronde niet gevonden');
    db.run('UPDATE rounds SET kind=?, title=?, instructions=?, supplies=?, minutes=?, judging=?, sort=?, settings=? WHERE id=?',
      body.kind ? kind : r.kind, str(body.title, 80) ?? r.title, body.instructions !== undefined ? str(body.instructions, 2000) : r.instructions,
      body.supplies !== undefined ? str(body.supplies, 1000) : r.supplies, int(body.minutes, 0, 300, r.minutes), body.judging !== undefined ? str(body.judging, 1000) : r.judging,
      int(body.sort, 0, 99999, r.sort), body.settings ? JSON.stringify({ ...json(r.settings, {}), ...body.settings }) : r.settings, r.id);
    return r.id;
  }
  if (!str(body.title)) bad('Rondetitel is verplicht.');
  const rid = id('r_');
  const sort = body.sort ?? db.get('SELECT COALESCE(MAX(sort),0)+10 AS s FROM rounds WHERE event_id = ?', eventId).s;
  db.run('INSERT INTO rounds (id, event_id, kind, title, instructions, supplies, minutes, judging, sort, settings) VALUES (?,?,?,?,?,?,?,?,?,?)',
    rid, eventId, kind, str(body.title, 80), str(body.instructions, 2000), str(body.supplies, 1000), int(body.minutes, 0, 300, 10), str(body.judging, 1000), sort, JSON.stringify(body.settings || {}));
  return rid;
}

export function deleteRound(db, eventId, rid) {
  const r = db.run('DELETE FROM rounds WHERE id = ? AND event_id = ?', rid, eventId);
  if (!r.changes) notFound('Ronde niet gevonden');
}

export function reorder(db, eventId, table, ids) {
  if (!['rounds', 'questions', 'teams'].includes(table) || !Array.isArray(ids)) bad('Ongeldige volgorde');
  db.tx(() => ids.forEach((x, i) => db.run(`UPDATE ${table} SET sort = ? WHERE id = ? AND event_id = ?`, (i + 1) * 10, x, eventId)));
}

export function upsertQuestion(db, eventId, body) {
  const type = QUESTION_TYPES.includes(body.type) ? body.type : 'mc';
  const options = Array.isArray(body.options) ? body.options.map(o => String(o).slice(0, 200)).filter(o => o.trim()).slice(0, 12) : [];
  if (type === 'tf') options.splice(0, options.length, 'Waar', 'Niet waar');
  if (['mc', 'order', 'match'].includes(type) && options.length < 2) bad('Geef minimaal twee keuzes.');
  if (!str(body.prompt)) bad('De vraag is verplicht.');
  const scope = body.scope === 'individual' ? 'individual' : 'team';
  const scoring = ['fixed', 'speed', 'closest'].includes(body.scoring) ? body.scoring : 'fixed';
  if (scoring === 'speed' && scope !== 'individual') bad('Snelheidsscore is alleen voor individuele vragen.');
  if (scoring === 'closest' && type !== 'number') bad('"Dichtstbij" werkt alleen bij getalvragen.');
  const seconds = int(body.seconds, 0, 600, 30);
  if (scoring === 'speed' && seconds < 5) bad('Een bliksemvraag heeft een timer nodig.');
  const t = Date.now();
  const settings = body.settings && typeof body.settings === 'object' ? body.settings : {};
  return db.tx(() => {
    let qid = body.id;
    const roundId = body.roundId;
    if (qid) {
      const q = db.get('SELECT * FROM questions WHERE id = ? AND event_id = ?', qid, eventId) || notFound('Vraag niet gevonden');
      if (roundId && roundId !== q.round_id) db.get('SELECT 1 FROM rounds WHERE id = ? AND event_id = ?', roundId, eventId) || notFound('Ronde niet gevonden');
      db.run(`UPDATE questions SET round_id=?, type=?, scope=?, scoring=?, prompt=?, quote=?, context=?, options=?, media_id=?, points=?, seconds=?, allow_bet=?, is_example=?, settings=?, updated_at=? WHERE id=?`,
        roundId || q.round_id, type, scope, scoring, str(body.prompt, 500), str(body.quote, 1000), str(body.context, 1000), JSON.stringify(options),
        body.mediaId !== undefined ? (body.mediaId || null) : q.media_id, int(body.points, 0, 100, q.points), seconds, body.allowBet ? 1 : 0, body.isExample ? 1 : 0, JSON.stringify(settings), t, qid);
    } else {
      db.get('SELECT 1 FROM rounds WHERE id = ? AND event_id = ?', roundId, eventId) || notFound('Ronde niet gevonden');
      qid = id('q_');
      const sort = db.get('SELECT COALESCE(MAX(sort),0)+10 AS s FROM questions WHERE round_id = ?', roundId).s;
      db.run(`INSERT INTO questions (id, event_id, round_id, type, scope, scoring, prompt, quote, context, options, media_id, points, seconds, allow_bet, is_example, sort, settings, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, qid, eventId, roundId, type, scope, scoring, str(body.prompt, 500), str(body.quote, 1000), str(body.context, 1000),
        JSON.stringify(options), body.mediaId || null, int(body.points, 0, 100, 1), seconds, body.allowBet ? 1 : 0, body.isExample ? 1 : 0, sort, JSON.stringify(settings), t, t);
    }
    if (body.key) {
      const k = body.key;
      let correct = k.correct ?? null;
      if (type === 'mc' || type === 'tf') {
        const ok = i => Number.isInteger(i) && i >= 0 && i < options.length;
        if (Array.isArray(correct) ? !correct.every(ok) : (correct !== null && !ok(correct))) bad('Juiste antwoord valt buiten de keuzes.');
      }
      if (type === 'number' && correct !== null && correct !== '') { correct = Number(String(correct).replace(',', '.')); if (!Number.isFinite(correct)) bad('Juiste antwoord moet een getal zijn.'); }
      if (type === 'open' && correct !== null) correct = String(correct).slice(0, 200);
      const accepted = Array.isArray(k.accepted) ? k.accepted.map(a => String(a).slice(0, 200)).filter(a => a.trim()).slice(0, 30) : [];
      db.run(`INSERT INTO answer_keys (question_id, correct, accepted, explanation, tolerance) VALUES (?,?,?,?,?)
        ON CONFLICT(question_id) DO UPDATE SET correct = excluded.correct, accepted = excluded.accepted, explanation = excluded.explanation, tolerance = excluded.tolerance`,
        qid, JSON.stringify(correct === '' ? null : correct), JSON.stringify(accepted), str(k.explanation, 1000), k.tolerance != null && k.tolerance !== '' ? Number(k.tolerance) : null);
    }
    return qid;
  });
}

export function deleteQuestion(db, eventId, qid) {
  const live = db.get('SELECT question_id, phase FROM live_state WHERE event_id = ?', eventId);
  if (live?.question_id === qid && live.phase === 'open') bad('Deze vraag staat nu open.');
  const r = db.run('DELETE FROM questions WHERE id = ? AND event_id = ?', qid, eventId);
  if (!r.changes) notFound('Vraag niet gevonden');
}

/**
 * Dupliceer een avond. Kopieert instellingen, rondes, vragen en (optioneel) teams-namen.
 * Kopieert NOOIT: deelnemers-sessies, antwoorden, stemmen, shots, bewijs, investeringen of scores.
 */
export function duplicateEvent(db, srcId, { name, includeQuestions = true, includeTeams = false, includeParticipants = false } = {}) {
  const src = db.get('SELECT * FROM events WHERE id = ?', srcId) || notFound();
  const res = createEvent(db, { name: name || src.name + ' (kopie)', subtitle: src.subtitle, mode: src.mode, settings: json(src.settings, {}), durationTarget: src.duration_target, durationMax: src.duration_max });
  const dst = res.event.id;
  db.tx(() => {
    const teamMap = new Map();
    if (includeTeams) for (const t of db.all('SELECT * FROM teams WHERE event_id = ?', srcId)) {
      const nid = id('t_'); teamMap.set(t.id, nid);
      db.run('INSERT INTO teams (id, event_id, name, color, sort, created_at) VALUES (?,?,?,?,?,?)', nid, dst, t.name, t.color, t.sort, Date.now());
    }
    if (includeParticipants) for (const p of db.all('SELECT p.*, m.team_id FROM participants p LEFT JOIN memberships m ON m.participant_id = p.id WHERE p.event_id = ?', srcId)) {
      const nid = id('p_');
      db.run('INSERT INTO participants (id, event_id, name, created_at) VALUES (?,?,?,?)', nid, dst, p.name, Date.now());
      if (p.team_id && teamMap.has(p.team_id)) setTeam(db, dst, nid, teamMap.get(p.team_id));
    }
    for (const r of db.all('SELECT * FROM rounds WHERE event_id = ? ORDER BY sort', srcId)) {
      const rid = id('r_');
      db.run('INSERT INTO rounds (id, event_id, kind, title, instructions, supplies, minutes, judging, sort, settings) VALUES (?,?,?,?,?,?,?,?,?,?)',
        rid, dst, r.kind, r.title, r.instructions, r.supplies, r.minutes, r.judging, r.sort, r.settings);
      if (!includeQuestions) continue;
      for (const q of db.all('SELECT * FROM questions WHERE round_id = ?', r.id)) {
        const qid = id('q_'); const t = Date.now();
        db.run(`INSERT INTO questions (id, event_id, round_id, type, scope, scoring, prompt, quote, context, options, media_id, points, seconds, allow_bet, is_example, sort, settings, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,?)`, qid, dst, rid, q.type, q.scope, q.scoring, q.prompt, q.quote, q.context, q.options, q.points, q.seconds, q.allow_bet, q.is_example, q.sort, q.settings, t, t);
        const k = db.get('SELECT * FROM answer_keys WHERE question_id = ?', q.id);
        if (k) db.run('INSERT INTO answer_keys (question_id, correct, accepted, explanation, tolerance) VALUES (?,?,?,?,?)', qid, k.correct, k.accepted, k.explanation, k.tolerance);
      }
    }
    for (const m of db.all('SELECT * FROM missions WHERE event_id = ?', srcId))
      db.run('INSERT INTO missions (id, event_id, title, description, kind, target, unit, max_points, sort) VALUES (?,?,?,?,?,?,?,?,?)', id('m_'), dst, m.title, m.description, m.kind, m.target, m.unit, m.max_points, m.sort);
  });
  return res;
}
