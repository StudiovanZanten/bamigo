// Spelvormen met eigen regels: Ranking de Boys, Shot in het duister, Dragons, Ken je kompaan, Buitentas.
import { id, json } from './db.js';
import { bad, deny, notFound, HttpError } from './auth.js';
import { judgeOpen, normalize, competitionRanks, pointsForRank } from './scoring.js';

const conflict = m => { throw new HttpError(409, m, 'conflict'); };
export const DRAGONS_BUDGET = 10000, DRAGONS_STEP = 500;

// ---------- Ranking de Boys ----------
/** Stemtotalen voor een rankingvraag. Alleen totalen; nooit wie op wie stemde. */
export function rankingTotals(db, qid) {
  const rows = db.all(`SELECT p.id, p.name, COUNT(*) AS votes FROM ranking_votes v JOIN participants p ON p.id = v.choice_id
    WHERE v.question_id = ? AND v.choice_id IS NOT NULL GROUP BY p.id ORDER BY votes DESC, p.name`, qid);
  const max = rows[0]?.votes ?? 0;
  return { rows, winners: rows.filter(r => r.votes === max && max > 0).map(r => r.id), valid: rows.reduce((a, r) => a + r.votes, 0) };
}

export function castVote(db, eventId, participant, { questionId, choiceId }) {
  const q = db.get("SELECT * FROM questions WHERE id = ? AND event_id = ? AND type = 'ranking'", questionId, eventId) || notFound('Rankingvraag niet gevonden');
  const live = db.get('SELECT question_id FROM live_state WHERE event_id = ?', eventId);
  if (q.locked_at || live?.question_id === q.id || db.get('SELECT 1 FROM submissions WHERE question_id = ? LIMIT 1', q.id)) conflict('Stemmen voor deze vraag is gesloten.');
  const settings = json(db.get('SELECT settings FROM events WHERE id = ?', eventId).settings, {});
  let choice = null;
  if (choiceId) {
    choice = db.get('SELECT id FROM participants WHERE id = ? AND event_id = ?', choiceId, eventId)?.id || bad('Kies een deelnemer van deze avond.');
    if (!settings.selfVote && choice === participant.id) bad('Op jezelf stemmen staat uit.');
  }
  db.run(`INSERT INTO ranking_votes (id, event_id, question_id, voter_id, choice_id, created_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(question_id, voter_id) DO UPDATE SET choice_id = excluded.choice_id, created_at = excluded.created_at`, id('v_'), eventId, q.id, participant.id, choice, Date.now());
}

// ---------- Shot in het duister ----------
export function saveShot(db, eventId, teamId, body, by) {
  db.get('SELECT 1 FROM teams WHERE id = ? AND event_id = ?', teamId, eventId) || notFound('Team niet gevonden');
  const s = v => (v == null ? null : String(v).trim().slice(0, 500) || null);
  const cur = db.get('SELECT * FROM shots WHERE team_id = ?', teamId);
  const t = Date.now();
  if (cur) db.run('UPDATE shots SET name=?, flavor=?, base=?, ingredients=?, allergens=?, story=?, amount=?, updated_at=?, updated_by=? WHERE id=?',
    s(body.name), s(body.flavor), s(body.base), s(body.ingredients), s(body.allergens), s(body.story), s(body.amount), t, by, cur.id);
  else db.run('INSERT INTO shots (id, event_id, team_id, name, flavor, base, ingredients, allergens, story, amount, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    id('sh_'), eventId, teamId, s(body.name), s(body.flavor), s(body.base), s(body.ingredients), s(body.allergens), s(body.story), s(body.amount), t, by);
}

/** Organisatie: nummer en toegestane varianten vastleggen. */
export function adminShot(db, eventId, shotId, { number, acceptedFlavors, acceptedBases }) {
  const sh = db.get('SELECT * FROM shots WHERE id = ? AND event_id = ?', shotId, eventId) || notFound('Shot niet gevonden');
  const n = number === '' || number == null ? null : Number(number);
  if (n !== null && (!Number.isInteger(n) || n < 1 || n > 50)) bad('Ongeldig shotnummer.');
  if (n !== null && db.get('SELECT 1 FROM shots WHERE event_id = ? AND number = ? AND id <> ?', eventId, n, sh.id)) bad(`Nummer ${n} is al vergeven.`);
  const list = a => JSON.stringify((Array.isArray(a) ? a : String(a || '').split('\n')).map(x => String(x).trim()).filter(Boolean).slice(0, 20));
  db.run('UPDATE shots SET number = ?, accepted_flavors = ?, accepted_bases = ? WHERE id = ?', n, list(acceptedFlavors), list(acceptedBases), sh.id);
}

/** Waarschuwing voor (bijna) identieke shots — alleen voor inhoudsbeheer. */
export function shotWarnings(db, eventId) {
  const shots = db.all('SELECT s.*, t.name AS team FROM shots s JOIN teams t ON t.id = s.team_id WHERE s.event_id = ?', eventId);
  const out = [];
  for (let i = 0; i < shots.length; i++) for (let j = i + 1; j < shots.length; j++) {
    const a = shots[i], b = shots[j];
    if (a.flavor && b.flavor && normalize(a.flavor) === normalize(b.flavor) && normalize(a.base || '') === normalize(b.base || '')) out.push(`${a.team} en ${b.team} hebben dezelfde smaak en basis.`);
  }
  for (const s of shots) if (s.name && !s.allergens) out.push(`${s.team}: allergenen nog niet ingevuld (vul “geen” in als er geen zijn).`);
  return out;
}

const shotForQuestion = (db, q) => db.get('SELECT s.*, t.name AS team_name FROM shots s JOIN teams t ON t.id = s.team_id WHERE s.event_id = ? AND s.number = ?', q.event_id, q.settings.shotNumber);

export function shotQuestionsInRound(db, roundId) {
  return db.all("SELECT * FROM questions WHERE round_id = ? AND type = 'shot' AND voided_at IS NULL ORDER BY sort, id", roundId).map(q => ({ ...q, settings: json(q.settings, {}) }));
}

// ---------- Ken je kompaan ----------
/** Welke twee spelers antwoorden voor dit team? Duo: beiden. Trio: vaste, zichtbare rotatie per vraag. */
export function kompaanPair(db, q, teamId) {
  const members = db.all('SELECT p.id, p.name FROM memberships m JOIN participants p ON p.id = m.participant_id WHERE m.team_id = ? ORDER BY p.name, p.id', teamId);
  const override = q.settings?.pairs?.[teamId];
  if (Array.isArray(override) && override.length === 2) return members.filter(m => override.includes(m.id));
  if (members.length <= 2) return members;
  const ks = db.all("SELECT id FROM questions WHERE round_id = ? AND json_extract(settings, '$.kompaan') = 1 ORDER BY sort, id", q.round_id).map(r => r.id);
  const k = Math.max(0, ks.indexOf(q.id));
  const skip = k % members.length;
  return members.filter((_, i) => i !== skip).slice(0, 2);
}

const sameAnswer = (q, a, b) => (q.type === 'mc' || q.type === 'tf') ? a === b : judgeOpen(a, [b]) === 'correct';

// ---------- validatie per type ----------
export function validateModuleAnswer(db, q, answer, eventId, membership) {
  switch (q.type) {
    case 'shot': {
      const a = answer || {};
      const teamId = String(a.teamId || '');
      if (teamId && !db.get('SELECT 1 FROM teams WHERE id = ? AND event_id = ?', teamId, eventId)) bad('Onbekend team.');
      if (teamId && teamId === membership?.team_id) bad('Kies een ander team dan je eigen team.');
      const flavor = String(a.flavor || '').trim().slice(0, 100), base = String(a.base || '').trim().slice(0, 100);
      if (!flavor && !base && !teamId) bad('Vul minstens één onderdeel in.');
      return { flavor, base, teamId: teamId || null };
    }
    case 'invest': {
      const a = answer && typeof answer === 'object' ? answer : bad('Ongeldige verdeling.');
      const out = {}; let sum = 0;
      for (const [tid, v] of Object.entries(a)) {
        const amt = Number(v);
        if (!amt) continue;
        if (!Number.isInteger(amt) || amt < 0 || amt % DRAGONS_STEP) bad(`Bedragen in stappen van €${DRAGONS_STEP}.`);
        if (tid === membership?.team_id) bad('Je mag niet in je eigen team investeren.');
        if (!db.get('SELECT 1 FROM teams WHERE id = ? AND event_id = ?', tid, eventId)) bad('Onbekend team.');
        out[tid] = amt; sum += amt;
      }
      const budget = q.settings.budget || DRAGONS_BUDGET;
      if (sum !== budget) bad(`Verdeel precies €${budget.toLocaleString('nl-NL')} (nu €${sum.toLocaleString('nl-NL')}).`);
      return out;
    }
    default: return undefined;
  }
}

/** Extra toegangsregels bij indienen. */
export function checkModuleSubmit(db, q, participant, membership) {
  if (q.type === 'shot') {
    const sh = shotForQuestion(db, q);
    if (sh && membership && sh.team_id === membership.team_id) deny('Dit is jullie eigen shot: hier scoren jullie niet op. Geniet ervan.');
  }
  if (q.settings?.kompaan) {
    if (!membership) deny('Je zit niet in een team.');
    const pair = kompaanPair(db, q, membership.team_id);
    if (!pair.some(p => p.id === participant.id)) deny('Bij deze vraag antwoorden je teamgenoten. Jij kijkt mee.');
  }
}

// ---------- scoren per type ----------
/** Geeft true als de vraag door een module is gescoord. `add(teamId, participantId, board, sourceSuffix, points, reason)` */
export function scoreModule(db, q, key, subs, add) {
  if (q.type === 'ranking') {
    const { winners, valid } = rankingTotals(db, q.id);
    for (const s of subs) {
      const ok = valid > 0 && winners.includes(JSON.parse(s.answer));
      db.run('UPDATE submissions SET verdict = ? WHERE id = ?', valid > 0 ? (ok ? 'correct' : 'wrong') : null, s.id);
      if (ok) add(s.team_id, s.participant_id, q.scope === 'individual' ? 'individual' : 'team', s.owner_key, q.points || 2, 'Ranking: goed voorspeld');
    }
    return true;
  }
  if (q.type === 'shot') {
    const sh = shotForQuestion(db, q);
    if (!sh) return true;
    const flavors = [sh.flavor, ...json(sh.accepted_flavors, [])].filter(Boolean);
    const bases = [sh.base, ...json(sh.accepted_bases, [])].filter(Boolean);
    for (const s of subs) {
      if (s.team_id === sh.team_id) continue; // nooit punten op eigen shot
      const a = JSON.parse(s.answer);
      const f = !!a.flavor && judgeOpen(a.flavor, flavors) === 'correct';
      const b = !!a.base && judgeOpen(a.base, bases) === 'correct';
      const t = a.teamId === sh.team_id;
      const pts = (f ? 1 : 0) + (b ? 1 : 0) + (t ? 1 : 0);
      db.run('UPDATE submissions SET verdict = ? WHERE id = ?', pts === 3 ? 'correct' : pts ? 'partial' : 'wrong', s.id);
      if (pts) add(s.team_id, null, 'team', s.owner_key, pts, `Shot ${sh.number}: smaak ${f ? '✓' : '✗'} · basis ${b ? '✓' : '✗'} · team ${t ? '✓' : '✗'}`);
    }
    return true;
  }
  if (q.type === 'invest') {
    const teams = db.all('SELECT id, name FROM teams WHERE event_id = ?', q.event_id);
    const totals = new Map(teams.map(t => [t.id, 0]));
    for (const s of subs) for (const [tid, amt] of Object.entries(JSON.parse(s.answer))) totals.set(tid, (totals.get(tid) ?? 0) + amt);
    const items = teams.map(t => ({ ...t, total: totals.get(t.id) }));
    const ranks = competitionRanks(items, i => i.total);
    const scale = q.settings.scale || [5, 4, 3, 2, 1];
    for (const it of items) { const p = pointsForRank(ranks.get(it), scale); if (p && it.total > 0) add(it.id, null, 'team', 't:' + it.id, p, `Dragons: €${it.total.toLocaleString('nl-NL')} opgehaald (plek ${ranks.get(it)})`); }
    return true;
  }
  if (q.settings?.kompaan) {
    const byTeam = new Map();
    for (const s of subs) { if (!byTeam.has(s.team_id)) byTeam.set(s.team_id, []); byTeam.get(s.team_id).push(s); }
    for (const [teamId, list] of byTeam) {
      const pair = kompaanPair(db, q, teamId).map(p => p.id);
      const ans = pair.map(pid => list.find(s => s.participant_id === pid)).filter(Boolean);
      const ok = ans.length === 2 && sameAnswer(q, JSON.parse(ans[0].answer), JSON.parse(ans[1].answer));
      for (const s of list) db.run('UPDATE submissions SET verdict = ? WHERE id = ?', ok ? 'correct' : 'wrong', s.id);
      if (ok) add(teamId, null, 'team', 't:' + teamId, q.points || 1, 'Ken je kompaan: zelfde antwoord');
    }
    return true;
  }
  return false;
}

/** Onthullingsinformatie per type (alleen na onthulling aangeroepen). */
export function revealModule(db, q) {
  if (q.type === 'ranking') {
    const { rows, winners, valid } = rankingTotals(db, q.id);
    return { ranking: { top: rows.slice(0, 5).map(r => ({ name: r.name, votes: r.votes, winner: winners.includes(r.id) })), valid, skipped: valid === 0 } };
  }
  if (q.type === 'invest') {
    const teams = db.all('SELECT id, name FROM teams WHERE event_id = ? ORDER BY sort, name', q.event_id);
    const totals = new Map(teams.map(t => [t.id, 0]));
    for (const s of db.all('SELECT answer FROM submissions WHERE question_id = ?', q.id)) for (const [tid, amt] of Object.entries(JSON.parse(s.answer))) totals.set(tid, (totals.get(tid) ?? 0) + amt);
    return { invest: teams.map(t => ({ name: t.name, total: totals.get(t.id) })).sort((a, b) => b.total - a.total) };
  }
  if (q.settings?.kompaan) {
    const teams = db.all('SELECT id, name FROM teams WHERE event_id = ? ORDER BY sort, name', q.event_id);
    return { kompaan: teams.map(t => {
      const pair = kompaanPair(db, q, t.id);
      const answers = pair.map(p => { const s = db.get("SELECT answer, verdict FROM submissions WHERE question_id = ? AND owner_key = ?", q.id, 'p:' + p.id); return { name: p.name, answer: s ? JSON.parse(s.answer) : null, verdict: s?.verdict ?? null }; });
      return { team: t.name, answers, match: answers.length === 2 && answers.every(a => a.verdict === 'correct') };
    }) };
  }
  return null;
}

/** Volledige shotonthulling (pas als alle shots in de ronde zijn vastgezet). */
export function shotsRevealData(db, eventId, roundId) {
  const qs = shotQuestionsInRound(db, roundId);
  const shots = db.all('SELECT s.*, t.name AS team FROM shots s JOIN teams t ON t.id = s.team_id WHERE s.event_id = ? AND s.number IS NOT NULL ORDER BY s.number', eventId);
  const pts = db.all(`SELECT t.name, COALESCE(SUM(e.points),0) AS points FROM teams t LEFT JOIN score_events e ON e.team_id = t.id AND e.voided_at IS NULL
    AND e.question_id IN (SELECT id FROM questions WHERE round_id = ? AND type = 'shot') WHERE t.event_id = ? GROUP BY t.id ORDER BY points DESC, t.name`, roundId, eventId);
  return { shots: shots.map(s => ({ number: s.number, name: s.name, team: s.team, flavor: s.flavor, base: s.base, story: s.story })), points: pts, questions: qs.length };
}

// ---------- Buitentas / missies ----------
export function upsertMission(db, eventId, body) {
  const s = (v, n = 300) => (v == null ? null : String(v).trim().slice(0, n) || null);
  const kind = body.kind === 'check' ? 'check' : 'closest';
  if (body.id) {
    db.get('SELECT 1 FROM missions WHERE id = ? AND event_id = ?', body.id, eventId) || notFound('Missie niet gevonden');
    db.run('UPDATE missions SET title=?, description=?, kind=?, target=?, unit=?, max_points=? WHERE id=?', s(body.title, 100), s(body.description, 1000), kind, s(body.target, 40), s(body.unit, 20), Math.max(0, Math.min(20, Number(body.maxPoints) || 5)), body.id);
    return body.id;
  }
  if (!s(body.title)) bad('Titel is verplicht.');
  if (db.get('SELECT COUNT(*) n FROM missions WHERE event_id = ?', eventId).n >= 8) bad('Houd het haalbaar: maximaal 8 missies.');
  const mid = id('mi_');
  db.run('INSERT INTO missions (id, event_id, title, description, kind, target, unit, max_points, sort) VALUES (?,?,?,?,?,?,?,?,?)', mid, eventId, s(body.title, 100), s(body.description, 1000), kind, s(body.target, 40), s(body.unit, 20), Math.max(0, Math.min(20, Number(body.maxPoints) || 5)), Date.now() % 100000);
  return mid;
}

export function saveEvidence(db, eventId, teamId, missionId, { value, note, mediaId }, by) {
  db.get('SELECT 1 FROM missions WHERE id = ? AND event_id = ?', missionId, eventId) || notFound('Missie niet gevonden');
  const m = db.get('SELECT scored_at FROM missions WHERE id = ?', missionId);
  if (m.scored_at) conflict('Deze missie is al beoordeeld.');
  const s = (v, n) => (v == null ? null : String(v).trim().slice(0, n) || null);
  db.run(`INSERT INTO evidence (id, event_id, mission_id, team_id, value, note, media_id, created_at, updated_by) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(mission_id, team_id) DO UPDATE SET value = excluded.value, note = excluded.note, media_id = COALESCE(excluded.media_id, evidence.media_id), updated_by = excluded.updated_by`,
    id('ev_'), eventId, missionId, teamId, s(value, 100), s(note, 500), mediaId || null, Date.now(), by);
}

/** Douane: gecontroleerde waarde en goedkeuring vastleggen. */
export function checkEvidence(db, eventId, missionId, teamId, { measured, checked }) {
  db.get('SELECT 1 FROM missions WHERE id = ? AND event_id = ?', missionId, eventId) || notFound('Missie niet gevonden');
  db.get('SELECT 1 FROM teams WHERE id = ? AND event_id = ?', teamId, eventId) || notFound('Team niet gevonden');
  db.run(`INSERT INTO evidence (id, event_id, mission_id, team_id, measured, checked, created_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(mission_id, team_id) DO UPDATE SET measured = excluded.measured, checked = excluded.checked`,
    id('ev_'), eventId, missionId, teamId, measured == null || measured === '' ? null : String(measured).slice(0, 40), checked ? 1 : 0, Date.now());
}

/** "12:00" → minuten; "247" / "247,5" → getal. */
export function parseMeasure(v) {
  if (v == null || v === '') return null;
  const m = String(v).trim().match(/^(\d{1,2})[:.](\d{2})(?::(\d{2}))?$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(m[3]) / 60 : 0);
  const n = Number(String(v).replace(',', '.').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Scoor een missie: dichtstbij doel → schaal 5-4-3-2-1 met gedeelde rang; check → max punten. Niet ingeleverd = 0. */
export function scoreMission(db, eventId, missionId, add) {
  const m = db.get('SELECT * FROM missions WHERE id = ? AND event_id = ?', missionId, eventId) || notFound('Missie niet gevonden');
  const ev = db.all('SELECT e.*, t.name AS team FROM evidence e JOIN teams t ON t.id = e.team_id WHERE e.mission_id = ? AND e.checked = 1', m.id);
  const results = [];
  if (m.kind === 'check') {
    for (const e of ev) { add(e.team_id, `m:${m.id}:${e.team_id}`, m.max_points, `${m.title}: ingeleverd en goedgekeurd`); results.push({ team: e.team, points: m.max_points }); }
  } else {
    const target = parseMeasure(m.target);
    if (target == null) bad('Stel eerst een doelwaarde in (bijv. 12:00 of 250).');
    const valid = ev.map(e => ({ ...e, diff: Math.abs((parseMeasure(e.measured ?? e.value) ?? NaN) - target) })).filter(e => Number.isFinite(e.diff));
    const ranks = competitionRanks(valid, e => e.diff, false);
    const n = db.get('SELECT COUNT(*) n FROM teams WHERE event_id = ?', eventId).n;
    const scale = Array.from({ length: n }, (_, i) => Math.max(0, Math.min(m.max_points, n) - i));
    for (const e of valid) { const p = pointsForRank(ranks.get(e), scale); if (p) add(e.team_id, `m:${m.id}:${e.team_id}`, p, `${m.title}: plek ${ranks.get(e)} (afwijking ${+e.diff.toFixed(2)}${m.unit ? ' ' + m.unit : ''})`); results.push({ team: e.team, points: p, rank: ranks.get(e) }); }
  }
  db.run('UPDATE missions SET scored_at = ? WHERE id = ?', Date.now(), m.id);
  return results;
}
