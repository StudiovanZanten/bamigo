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

/** Top-N uit de stemmen met gedeelde plekken (competitierang). */
export function rankingTop(db, qid) {
  const { rows, valid } = rankingTotals(db, qid);
  let rank = 0, prev = null;
  const ranked = rows.map((r, i) => { if (r.votes !== prev) { rank = i + 1; prev = r.votes; } return { ...r, rank }; });
  // span: hoeveel plekken een gedeelde rang beslaat (2x gedeeld 1e = plek 1 en 2)
  for (const r of ranked) r.span = ranked.filter(x => x.rank === r.rank).length;
  return { ranked, valid };
}
/** Punten voor een top-N voorspelling: 2 per naam op de goede plek, 1 per naam die wel in de top-N staat. */
export function scoreTopPrediction(ranked, picks, top) {
  let pts = 0; const detail = [];
  picks.forEach((id, i) => {
    const pos = i + 1; const r = ranked.find(x => x.id === id);
    if (r && r.rank <= top && pos >= r.rank && pos <= r.rank + r.span - 1) { pts += 2; detail.push(2); }
    else if (r && r.rank <= top) { pts += 1; detail.push(1); }
    else detail.push(0);
  });
  return { pts, detail };
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

// ---------- Van wie is deze carrière? ----------
/** De deelnemer om wie het gaat: key.correct is een deelnemer-id of (makkelijker in een pakket) zijn naam. */
export function careerSubject(db, q, key) {
  const c = key?.correct; if (c == null || c === '') return null;
  const people = db.all('SELECT p.id, p.name, m.team_id FROM participants p LEFT JOIN memberships m ON m.participant_id = p.id WHERE p.event_id = ?', q.event_id);
  return people.find(p => p.id === c) || people.find(p => normalize(p.name) === normalize(String(c))) || null;
}
/** Hoeveel hints staan er nu (of stonden er bij een inzending) op tv? Handmatig via de host, of automatisch per clueSeconds. */
export function careerShown(q, s, t) {
  const n = q.settings.clues?.length || 0;
  if (['revealed', 'scored'].includes(s.phase)) return n;
  if (!['open', 'closed'].includes(s.phase) || !s.open_at) return 0;
  const sec = q.settings.clueSeconds || 0;
  if (sec > 0) {
    const now = s.phase === 'closed' ? (s.deadline || t) : s.paused ? s.paused_at : t;
    return Math.min(n, 1 + Math.floor(Math.max(0, now - s.open_at) / (sec * 1000)));
  }
  return Math.min(n, Math.max(1, q.settings.cluesShown || 1));
}
export const careerPoints = (q, clue) => q.settings.scale?.[clue - 1] ?? 0;

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
    case 'career': {
      const pid = String(answer && typeof answer === 'object' ? answer.pick : answer ?? '');
      if (!db.get('SELECT 1 FROM participants WHERE id = ? AND event_id = ?', pid, eventId)) bad('Kies een Muchacho.');
      return pid;
    }
    case 'envelope': {
      const n = db.get('SELECT COUNT(*) AS n FROM teams WHERE event_id = ?', eventId).n;
      if (!membership) {
        // Envelop van de quizmaster: volledige top (team-id's in volgorde), puur voor de lol.
        if (!Array.isArray(answer) || answer.length !== n || new Set(answer).size !== n) bad(`Zet alle ${n} teams in een volgorde.`);
        return answer.map(t => { if (!db.get('SELECT 1 FROM teams WHERE id = ? AND event_id = ?', String(t), eventId)) bad('Onbekend team.'); return String(t); });
      }
      const obj = answer && typeof answer === 'object';
      const i = Number(obj ? answer.place : answer); if (!Number.isInteger(i) || i < 0 || i >= n) bad('Kies een plek.');
      if (!q.settings.pledge) return i;
      const pledge = String((obj ? answer.pledge : '') ?? '').trim().slice(0, 200);
      return { place: i, pledge };
    }
    case 'invest': {
      if (q.settings.pitch) {
        // Biedronde per pitch: één bedrag op het team dat nu pitcht, uit je resterende budget.
        const pt = q.settings.pitchTeam; if (!pt) bad('De quizmaster heeft nog niet gekozen wie er pitcht.');
        if (membership && membership.team_id === pt) bad('Jullie pitchen zelf. Bieden kan bij de andere pitches.');
        const st = pitchStatus(db, q, membership ? 't:' + membership.team_id : 'host', membership?.team_id ?? null);
        const amt = Number(answer && typeof answer === 'object' ? answer.amount : answer);
        if (!Number.isInteger(amt) || amt < 0 || amt % DRAGONS_STEP) bad(`Bieden in stappen van €${DRAGONS_STEP}.`);
        if (amt > st.remaining) bad(`Zoveel hebben jullie niet meer (nog €${st.remaining.toLocaleString('nl-NL')}).`);
        if (st.mustAll && amt !== st.remaining) bad(`Laatste kans: jullie resterende €${st.remaining.toLocaleString('nl-NL')} moet er helemaal in.`);
        return { amount: amt };
      }
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
/** Alle pitches (biedronde-vragen) van dezelfde Dragons-ronde. */
export function pitchQuestions(db, roundId) {
  return db.all("SELECT * FROM questions WHERE round_id = ? AND type = 'invest' AND voided_at IS NULL ORDER BY sort, id", roundId)
    .map(x => ({ ...x, settings: json(x.settings, {}) })).filter(x => x.settings.pitch);
}
/** Resterend budget en of dit de laatste biedkans is (dan moet alles erin). owner: 't:<team>' of 'host'. */
export function pitchStatus(db, q, owner, teamId) {
  const all = pitchQuestions(db, q.round_id);
  const budget = q.settings.budget || DRAGONS_BUDGET;
  let spent = 0;
  for (const p of all) if (p.id !== q.id) { const s = db.get('SELECT answer FROM submissions WHERE question_id = ? AND owner_key = ?', p.id, owner); if (s) spent += JSON.parse(s.answer).amount || 0; }
  const future = all.filter(p => p.id !== q.id && !p.locked_at);
  const pitched = new Set(all.filter(p => p.locked_at || p.id === q.id).map(p => p.settings.pitchTeam).filter(Boolean));
  const later = future.length - (teamId && !pitched.has(teamId) ? 1 : 0); // één van de komende pitches is van jezelf
  return { budget, remaining: budget - spent, mustAll: later <= 0, later, pitchTeam: q.settings.pitchTeam || null };
}
function pitchTotals(db, q) {
  const all = pitchQuestions(db, q.round_id);
  const teams = db.all('SELECT id, name FROM teams WHERE event_id = ?', q.event_id);
  return { all, rows: all.filter(p => p.settings.pitchTeam).map(p => ({ teamId: p.settings.pitchTeam, name: teams.find(t => t.id === p.settings.pitchTeam)?.name ?? '?', item: p.prompt,
    total: db.all('SELECT answer FROM submissions WHERE question_id = ?', p.id).reduce((s, x) => s + (JSON.parse(x.answer).amount || 0), 0) })) };
}

export function scoreModule(db, q, key, subs, add) {
  if (q.type === 'invest' && q.settings?.pitch) {
    const { all, rows } = pitchTotals(db, q);
    if (all.some(p => p.id !== q.id && !p.locked_at)) return true; // punten pas na de laatste pitch
    const ranks = competitionRanks(rows, r => r.total);
    const scale = q.settings.scale || [5, 4, 3, 2, 1];
    for (const r of rows) { const p = pointsForRank(ranks.get(r), scale); if (p && r.total > 0) add(r.teamId, null, 'team', 't:' + r.teamId, p, `Dragons: €${r.total.toLocaleString('nl-NL')} opgehaald met “${r.item}” (plek ${ranks.get(r)})`); }
    return true;
  }
  if (q.type === 'envelope') return true; // punten pas bij het openen van de enveloppen
  if (q.type === 'career') {
    const who = careerSubject(db, q, key);
    for (const s of subs) {
      if (s.owner_key === 'host' || s.verdict !== 'correct') continue;
      const a = JSON.parse(s.answer); const clue = a.clue || 1;
      if (who && who.team_id === s.team_id && !q.settings.ownTeam) continue; // je eigen teamgenoot raden telt niet
      const p = careerPoints(q, clue);
      if (p) add(s.team_id, null, 'team', s.owner_key, p, `Carrière geraden bij hint ${clue}`);
    }
    return true;
  }
  if (q.type === 'ranking' && (q.settings?.top || 1) > 1) {
    const top = q.settings.top; const { ranked, valid } = rankingTop(db, q.id);
    for (const s of subs) {
      const { pts } = valid > 0 ? scoreTopPrediction(ranked, JSON.parse(s.answer), top) : { pts: 0 };
      db.run('UPDATE submissions SET verdict = ? WHERE id = ?', valid > 0 ? (pts > 0 ? 'correct' : 'wrong') : null, s.id);
      if (pts) add(s.team_id, s.participant_id, q.scope === 'individual' ? 'individual' : 'team', s.owner_key, pts, `Top ${top}: ${pts} punten`);
    }
    return true;
  }
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

/**
 * De BAMIGO Envelop: zet de stand (zonder envelopbonus) vast, vergelijk met de voorspelde plek per team
 * en schrijf de bonus bij. Opnieuw openen vervalt de vorige bonus eerst (nooit dubbel).
 */
export function openEnvelopes(db, eventId, q, t, actor, hostName) {
  db.run("UPDATE score_events SET voided_at = ?, voided_reason = 'enveloppen opnieuw geopend' WHERE event_id = ? AND source_key LIKE ? AND voided_at IS NULL", t, eventId, `env:${q.id}:%`);
  const teams = db.all(`SELECT t.id, t.name, COALESCE(SUM(CASE WHEN s.voided_at IS NULL AND s.board = 'team' THEN s.points END),0) AS points
    FROM teams t LEFT JOIN score_events s ON s.team_id = t.id WHERE t.event_id = ? GROUP BY t.id`, eventId);
  const ranks = competitionRanks(teams, x => x.points);
  const bonus = q.settings.bonus ?? 2;
  const list = teams.map(tm => {
    const sub = db.get('SELECT answer FROM submissions WHERE question_id = ? AND owner_key = ?', q.id, 't:' + tm.id);
    const a = sub ? JSON.parse(sub.answer) : null;
    const predicted = a == null ? null : (typeof a === 'object' ? a.place : a) + 1;
    const pledge = a && typeof a === 'object' ? a.pledge || '' : '';
    const rank = ranks.get(tm); const hit = predicted === rank;
    if (hit && bonus) db.run(`INSERT INTO score_events (id, event_id, team_id, board, question_id, source_key, points, reason, kind, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id('e_'), eventId, tm.id, 'team', q.id, `env:${q.id}:${tm.id}`, bonus, `BAMIGO Envelop: plek ${predicted} voorspeld en gehaald`, 'bonus', actor, t);
    return { teamId: tm.id, name: tm.name, predicted, rank, points: tm.points, hit, bonus: hit ? bonus : 0, pledge };
  });
  // Alleen de belofte van de laatste plek wordt onthuld (die moet hem ook uitvoeren); de rest blijft geheim.
  const last = Math.max(...list.map(r => r.rank));
  for (const r of list) { r.last = r.rank === last && list.length > 1; if (!r.last) delete r.pledge; }
  list.sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name)); // laatste plek eerst, winnaar als laatste
  const hs = db.get("SELECT answer FROM submissions WHERE question_id = ? AND owner_key = 'host'", q.id);
  let host = null;
  if (hs) {
    const order = JSON.parse(hs.answer);
    const rows = order.map((tid, i) => { const tm = teams.find(x => x.id === tid); return { name: tm?.name ?? '?', predicted: i + 1, rank: tm ? ranks.get(tm) : null }; });
    host = { name: hostName || 'Rinus', rows, hits: rows.filter(r => r.rank === r.predicted).length };
  }
  const result = { openedAt: t, bonus, list, host };
  db.run('UPDATE questions SET settings = ? WHERE id = ?', JSON.stringify({ ...q.settings, envelopes: result }), q.id);
  return result;
}

/** Onthullingsinformatie per type (alleen na onthulling aangeroepen). */
export function revealModule(db, q) {
  if (q.type === 'ranking' && (q.settings?.top || 1) > 1) {
    const top = q.settings.top; const { ranked, valid } = rankingTop(db, q.id);
    return { ranking: { topN: top, top: ranked.filter(r => r.rank <= Math.max(top, 3)).slice(0, 6).map(r => ({ id: r.id, name: r.name, votes: r.votes, rank: r.rank, winner: r.rank <= top })), valid, skipped: valid === 0 } };
  }
  if (q.type === 'ranking') {
    const { rows, winners, valid } = rankingTotals(db, q.id);
    return { ranking: { top: rows.slice(0, 5).map(r => ({ name: r.name, votes: r.votes, winner: winners.includes(r.id) })), valid, skipped: valid === 0 } };
  }
  if (q.type === 'career') {
    const who = careerSubject(db, q, { correct: db.get('SELECT correct FROM answer_keys WHERE question_id = ?', q.id)?.correct ? JSON.parse(db.get('SELECT correct FROM answer_keys WHERE question_id = ?', q.id).correct) : null });
    const teams = db.all('SELECT id, name FROM teams WHERE event_id = ? ORDER BY sort, name', q.event_id);
    const names = new Map(db.all('SELECT id, name FROM participants WHERE event_id = ?', q.event_id).map(p => [p.id, p.name]));
    const subs = db.all("SELECT team_id, answer, verdict FROM submissions WHERE question_id = ? AND owner_key != 'host'", q.id);
    return { career: { name: who?.name ?? null, clues: q.settings.clues, teams: teams.map(t => {
      const s = subs.find(x => x.team_id === t.id); const a = s ? JSON.parse(s.answer) : null;
      const own = !!(who && who.team_id === t.id && !q.settings.ownTeam);
      return { team: t.name, pick: a ? names.get(a.pick) ?? '?' : null, clue: a?.clue ?? null, correct: s?.verdict === 'correct', own, points: s?.verdict === 'correct' && !own ? careerPoints(q, a.clue || 1) : 0 };
    }) } };
  }
  if (q.type === 'invest' && q.settings?.pitch) {
    const { all, rows } = pitchTotals(db, q);
    if (all.some(p => p.id !== q.id && !p.locked_at)) return { pitchHidden: true, pitchesLeft: all.filter(p => p.id !== q.id && !p.locked_at).length };
    return { invest: rows.map(r => ({ name: `${r.name} · ${r.item}`, total: r.total })).sort((a, b) => b.total - a.total) };
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
