// Live spelverloop: state-machine per vraag, inzendingen, scoren en scorebord.
// Alles wat telt gebeurt hier, op de server. Clients krijgen alleen gefilterde views (views.js).
import { id, json } from './db.js';
import { HttpError, bad, deny, notFound } from './auth.js';
import { judgeOpen, speedScore, competitionRanks, pointsForRank, sameArray } from './scoring.js';

const conflict = (msg, code = 'conflict') => { throw new HttpError(409, msg, code); };

export const PHASES = ['idle', 'ready', 'open', 'closed', 'revealed', 'scored'];
export const SCREENS = ['lobby', 'round_intro', 'question', 'scoreboard', 'break', 'finale'];

export class Live {
  /** @param {{db, notify?:(eventId)=>void, clock?:()=>number, schedule?:boolean}} opts */
  constructor({ db, notify = () => {}, clock = Date.now, schedule = true }) {
    this.db = db; this.notify = notify; this.clock = clock; this.useTimers = schedule;
    this.timers = new Map();
  }

  // ---------- toestand ----------
  state(eventId) {
    let s = this.db.get('SELECT * FROM live_state WHERE event_id = ?', eventId);
    if (!s) {
      this.db.run('INSERT INTO live_state (event_id, updated_at) VALUES (?, ?)', eventId, this.clock());
      s = this.db.get('SELECT * FROM live_state WHERE event_id = ?', eventId);
    }
    return s;
  }

  question(qid) {
    const q = this.db.get('SELECT * FROM questions WHERE id = ?', qid);
    if (!q) return null;
    q.options = json(q.options, []); q.settings = json(q.settings, {});
    return q;
  }

  answerKey(qid) {
    const k = this.db.get('SELECT * FROM answer_keys WHERE question_id = ?', qid);
    return k ? { ...k, correct: json(k.correct), accepted: json(k.accepted, []) } : { correct: null, accepted: [] };
  }

  /** Zet live-state bij en verhoog seq. */
  #set(eventId, patch, actor, action) {
    const s = this.state(eventId);
    const next = { ...s, ...patch, seq: s.seq + 1, updated_at: this.clock() };
    this.db.run(`UPDATE live_state SET screen=?, round_id=?, question_id=?, phase=?, paused=?, open_at=?, deadline=?, paused_at=?, seq=?, message=?, updated_at=? WHERE event_id=?`,
      next.screen, next.round_id, next.question_id, next.phase, next.paused, next.open_at, next.deadline, next.paused_at, next.seq, next.message, next.updated_at, eventId);
    this.audit(eventId, actor, action, patch);
    return next;
  }

  audit(eventId, actor, action, detail) {
    this.db.run('INSERT INTO audit_log (event_id, actor, action, detail, created_at) VALUES (?,?,?,?,?)', eventId, actor || null, action, detail ? JSON.stringify(detail) : null, this.clock());
  }

  // ---------- host-acties ----------
  /**
   * Voer een hostactie uit. `seq` moet gelijk zijn aan de huidige seq: een dubbele klik
   * of verouderd scherm wordt geweigerd i.p.v. dat er onbedoeld iets doorschuift.
   */
  action(eventId, actor, { action, seq, questionId, roundId, reason, message }) {
    const result = this.db.tx(() => {
      const s = this.state(eventId);
      if (seq !== undefined && seq !== null && Number(seq) !== s.seq) conflict('Het scherm liep achter; actie niet uitgevoerd. Probeer opnieuw.', 'stale');
      const t = this.clock();
      switch (action) {
        case 'screen_lobby': case 'screen_scoreboard': case 'screen_break': case 'screen_finale': {
          if (s.phase === 'open') conflict('Sluit eerst de open vraag.');
          return this.#set(eventId, { screen: action.slice(7), message: message ?? null }, actor, action);
        }
        case 'round_intro': {
          if (s.phase === 'open') conflict('Sluit eerst de open vraag.');
          const r = this.db.get('SELECT id FROM rounds WHERE id = ? AND event_id = ?', roundId, eventId) || notFound('Ronde niet gevonden');
          return this.#set(eventId, { screen: 'round_intro', round_id: r.id, question_id: null, phase: 'idle', open_at: null, deadline: null }, actor, action);
        }
        case 'prepare': {
          if (s.phase === 'open') conflict('Sluit eerst de open vraag.');
          const q = this.db.get('SELECT id, round_id, voided_at FROM questions WHERE id = ? AND event_id = ?', questionId, eventId) || notFound('Vraag niet gevonden');
          if (q.voided_at) conflict('Deze vraag is ongeldig verklaard.');
          if (this.db.get('SELECT 1 FROM submissions WHERE question_id = ? LIMIT 1', q.id)) conflict('Deze vraag is al gespeeld. Kies een andere vraag (of verklaar hem ongeldig).');
          return this.#set(eventId, { screen: 'question', round_id: q.round_id, question_id: q.id, phase: 'ready', open_at: null, deadline: null, paused: 0, paused_at: null }, actor, action);
        }
        case 'open': {
          if (s.phase !== 'ready') conflict('Vraag kan alleen vanuit "klaar" worden geopend.');
          const q = this.question(s.question_id);
          const ev = this.db.get('SELECT settings FROM events WHERE id = ?', eventId);
          const countdown = json(ev.settings, {}).countdownMs ?? 3000;
          const openAt = t + countdown;
          const deadline = q.seconds > 0 ? openAt + q.seconds * 1000 : null;
          return this.#set(eventId, { phase: 'open', open_at: openAt, deadline, paused: 0, paused_at: null, screen: 'question' }, actor, action);
        }
        case 'close': {
          if (s.phase !== 'open') conflict('Er staat geen vraag open.');
          return this.#set(eventId, { phase: 'closed', paused: 0, paused_at: null, deadline: s.deadline && s.deadline < t ? s.deadline : t }, actor, action);
        }
        case 'reveal': {
          if (s.phase !== 'closed') conflict('Sluit de vraag eerst.');
          this.autoJudge(s.question_id);
          return this.#set(eventId, { phase: 'revealed' }, actor, action);
        }
        case 'score': {
          if (s.phase !== 'revealed' && s.phase !== 'scored') conflict('Onthul de vraag eerst.');
          this.scoreQuestion(eventId, s.question_id, actor);
          return this.#set(eventId, { phase: 'scored' }, actor, action);
        }
        case 'pause': {
          if (s.paused) conflict('Al gepauzeerd.');
          return this.#set(eventId, { paused: 1, paused_at: t }, actor, action);
        }
        case 'resume': {
          if (!s.paused) conflict('Niet gepauzeerd.');
          const shift = t - (s.paused_at ?? t);
          return this.#set(eventId, {
            paused: 0, paused_at: null,
            open_at: s.phase === 'open' && s.open_at ? s.open_at + shift : s.open_at,
            deadline: s.phase === 'open' && s.deadline ? s.deadline + shift : s.deadline,
          }, actor, action);
        }
        case 'void': {
          if (!s.question_id) conflict('Geen vraag geselecteerd.');
          if (!reason) bad('Geef een reden op.');
          this.db.run('UPDATE questions SET voided_at = ?, voided_reason = ? WHERE id = ?', t, reason, s.question_id);
          this.db.run('UPDATE score_events SET voided_at = ?, voided_reason = ? WHERE question_id = ? AND voided_at IS NULL', t, 'Vraag ongeldig: ' + reason, s.question_id);
          return this.#set(eventId, { phase: 'idle', open_at: null, deadline: null, paused: 0, paused_at: null, message: 'Vraag vervalt: ' + reason }, actor, action);
        }
        default: bad('Onbekende actie');
      }
    });
    this.reschedule(eventId);
    this.notify(eventId);
    return result;
  }

  /** Volgende vraag in de volgorde (na de huidige), of null. */
  nextQuestionId(eventId) {
    const s = this.state(eventId);
    const list = this.db.all(`SELECT q.id, q.voided_at, EXISTS (SELECT 1 FROM submissions s WHERE s.question_id = q.id) AS played
      FROM questions q JOIN rounds r ON r.id = q.round_id WHERE q.event_id = ? ORDER BY r.sort, r.id, q.sort, q.id`, eventId);
    const i = s.question_id ? list.findIndex(x => x.id === s.question_id) : -1;
    return list.slice(i + 1).find(x => !x.voided_at && !x.played)?.id ?? null;
  }

  // ---------- timers ----------
  reschedule(eventId) {
    if (!this.useTimers) return;
    for (const k of ['open', 'close']) { clearTimeout(this.timers.get(eventId + k)); this.timers.delete(eventId + k); }
    const s = this.state(eventId);
    if (s.phase !== 'open' || s.paused) return;
    const t = this.clock();
    if (s.open_at > t) this.timers.set(eventId + 'open', setTimeout(() => this.notify(eventId), s.open_at - t + 5));
    if (s.deadline) this.timers.set(eventId + 'close', setTimeout(() => this.autoClose(eventId, s.seq), Math.max(0, s.deadline - t) + 20));
  }

  autoClose(eventId, seq) {
    try {
      const s = this.state(eventId);
      if (s.phase === 'open' && !s.paused && s.seq === seq && s.deadline <= this.clock()) this.action(eventId, 'timer', { action: 'close', seq });
    } catch { /* al gesloten door host */ }
  }

  resumeAll() {
    for (const { event_id } of this.db.all("SELECT event_id FROM live_state WHERE phase = 'open'")) {
      const s = this.state(event_id);
      if (!s.paused && s.deadline && s.deadline <= this.clock()) this.autoClose(event_id, s.seq);
      else this.reschedule(event_id);
    }
  }

  // ---------- inzendingen ----------
  membership(pid) {
    return this.db.get('SELECT m.*, t.name AS team_name FROM memberships m JOIN teams t ON t.id = m.team_id WHERE m.participant_id = ?', pid);
  }

  /**
   * Speler stuurt een antwoord in. Idempotent: een tweede inzending (dubbele tap, retry,
   * tweede tabblad) geeft de eerste terug en telt nooit dubbel.
   */
  submit(eventId, participant, { questionId, answer, bet }) {
    const t = this.clock();
    const res = this.db.tx(() => {
      const s = this.state(eventId);
      if (s.question_id !== questionId) conflict('Deze vraag is niet (meer) actief.', 'not_active');
      const q = this.question(questionId);
      const m = this.membership(participant.id);
      const ownerKey = q.scope === 'team' ? (m ? 't:' + m.team_id : null) : 'p:' + participant.id;
      if (!ownerKey) deny('Je zit nog niet in een team.');
      if (q.scope === 'team' && !m.is_captain) deny('Alleen de captain stuurt het teamantwoord in.');
      const existing = this.db.get('SELECT * FROM submissions WHERE question_id = ? AND owner_key = ?', questionId, ownerKey);
      if (existing) return { submission: existing, duplicate: true };
      if (s.phase !== 'open') conflict('De vraag is gesloten.', 'closed');
      if (s.paused) conflict('Het spel is gepauzeerd.', 'paused');
      if (t < s.open_at) conflict('De vraag is nog niet geopend.', 'not_open');
      if (s.deadline && t > s.deadline) conflict('Te laat: de tijd was om.', 'late');
      if (q.scope === 'individual' && participant.joined_at && participant.joined_at > s.open_at) conflict('Je doet mee vanaf de volgende vraag.', 'late_join');
      const clean = validateAnswer(q, answer, this.db, eventId);
      let b = null;
      if (bet !== undefined && bet !== null) {
        if (!q.allow_bet) bad('Inzetten is bij deze vraag niet toegestaan.');
        b = Number(bet); if (![1, 2, 3].includes(b)) bad('Inzet moet 1, 2 of 3 zijn.');
      }
      const sub = {
        id: id('s_'), event_id: eventId, question_id: questionId, owner_key: ownerKey,
        participant_id: participant.id, team_id: m?.team_id ?? null, answer: JSON.stringify(clean),
        bet: b, received_at: t, elapsed_ms: t - s.open_at,
      };
      this.db.run(`INSERT INTO submissions (id, event_id, question_id, owner_key, participant_id, team_id, answer, bet, received_at, elapsed_ms)
        VALUES (?,?,?,?,?,?,?,?,?,?)`, sub.id, sub.event_id, sub.question_id, sub.owner_key, sub.participant_id, sub.team_id, sub.answer, sub.bet, sub.received_at, sub.elapsed_ms);
      return { submission: sub, duplicate: false };
    });
    if (!res.duplicate) this.notify(eventId);
    return res;
  }

  // ---------- beoordelen en scoren ----------
  /** Automatische beoordeling; handmatige oordelen (judged_by) blijven staan. */
  autoJudge(qid) {
    const q = this.question(qid); const key = this.answerKey(qid);
    for (const s of this.db.all('SELECT * FROM submissions WHERE question_id = ? AND judged_by IS NULL', qid)) {
      const a = json(s.answer);
      let v = 'wrong';
      switch (q.type) {
        case 'mc': case 'tf': v = (Array.isArray(key.correct) ? key.correct.includes(a) : a === key.correct) ? 'correct' : 'wrong'; break;
        case 'open': v = judgeOpen(a, [...(key.correct != null ? [String(key.correct)] : []), ...key.accepted]); break;
        case 'number': v = q.scoring === 'closest' ? null : (Math.abs(a - Number(key.correct)) <= (key.tolerance ?? 0) ? 'correct' : 'wrong'); break;
        case 'order': case 'match': v = sameArray(a, key.correct) ? 'correct' : 'wrong'; break;
        default: v = null;
      }
      this.db.run('UPDATE submissions SET verdict = ? WHERE id = ?', v, s.id);
    }
  }

  judge(eventId, actor, submissionId, verdict) {
    if (!['correct', 'wrong'].includes(verdict)) bad('Ongeldig oordeel');
    const s = this.db.get('SELECT * FROM submissions WHERE id = ? AND event_id = ?', submissionId, eventId) || notFound();
    this.db.run('UPDATE submissions SET verdict = ?, judged_by = ? WHERE id = ?', verdict, actor, s.id);
    this.audit(eventId, actor, 'judge', { submissionId, verdict });
    // Als de vraag al gescoord is, scoor opnieuw (idempotent).
    const st = this.state(eventId);
    if (st.question_id === s.question_id && st.phase === 'scored') this.scoreQuestion(eventId, s.question_id, actor);
    this.notify(eventId);
  }

  teamTotal(eventId, teamId) {
    return this.db.get("SELECT COALESCE(SUM(points),0) AS p FROM score_events WHERE event_id = ? AND team_id = ? AND board = 'team' AND voided_at IS NULL", eventId, teamId).p;
  }

  /**
   * Schrijf scoregebeurtenissen voor een vraag. Elke bron heeft een vaste source_key;
   * opnieuw scoren vervalt de oude regel en schrijft een nieuwe, zodat het totaal nooit verdubbelt.
   */
  scoreQuestion(eventId, qid, actor) {
    this.db.tx(() => {
      const q = this.question(qid); const key = this.answerKey(qid);
      const subs = this.db.all('SELECT * FROM submissions WHERE question_id = ?', qid);
      const t = this.clock();
      this.db.run("UPDATE score_events SET voided_at = ?, voided_reason = 'opnieuw gescoord' WHERE question_id = ? AND kind = 'auto' AND voided_at IS NULL", t, qid);
      const add = (sub, points, reason, board = 'team') => {
        this.db.run(`INSERT INTO score_events (id, event_id, team_id, participant_id, board, question_id, source_key, points, reason, kind, created_by, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, id('e_'), eventId, board === 'team' ? sub.team_id : null, board === 'individual' ? sub.participant_id : null,
          board, qid, `q:${qid}:${sub.owner_key}`, points, reason, 'auto', actor || null, t);
      };
      if (q.scoring === 'closest' && q.type === 'number') {
        const target = Number(key.correct);
        const scale = q.settings.scale || [5, 4, 3, 2, 1];
        const ranks = competitionRanks(subs, s => Math.abs(json(s.answer) - target), false);
        for (const s of subs) {
          const r = ranks.get(s); const p = pointsForRank(r, scale);
          this.db.run('UPDATE submissions SET verdict = ? WHERE id = ?', r === 1 ? 'correct' : 'wrong', s.id);
          if (p) add(s, p, `Dichtstbij: plek ${r}`, q.scope === 'individual' ? 'individual' : 'team');
        }
        return;
      }
      for (const s of subs) {
        const ok = s.verdict === 'correct';
        if (q.scoring === 'speed') { if (ok) add(s, speedScore(s.elapsed_ms, q.seconds), `Bliksem: goed in ${(s.elapsed_ms / 1000).toFixed(2)}s`, 'individual'); continue; }
        const board = q.scope === 'individual' ? 'individual' : 'team';
        if (s.bet && board === 'team') {
          if (ok) add(s, q.points + s.bet, `Goed + inzet ${s.bet}`);
          else {
            const total = this.teamTotal(eventId, s.team_id);
            const loss = Math.min(s.bet, Math.max(0, total));
            if (loss) add(s, -loss, `Fout, inzet ${s.bet} kwijt${loss < s.bet ? ' (minimum 0)' : ''}`);
          }
        } else if (ok) add(s, q.points, 'Goed antwoord', board);
      }
    });
  }

  /** Handmatige correctie of bonus, altijd met reden. */
  adjust(eventId, actor, { teamId, participantId, points, reason, kind = 'correction' }) {
    if (!reason || !String(reason).trim()) bad('Een reden is verplicht.');
    const p = Number(points); if (!Number.isInteger(p) || p === 0 || Math.abs(p) > 10000) bad('Ongeldig aantal punten.');
    if (teamId && !this.db.get('SELECT 1 FROM teams WHERE id = ? AND event_id = ?', teamId, eventId)) notFound('Team niet gevonden');
    if (participantId && !this.db.get('SELECT 1 FROM participants WHERE id = ? AND event_id = ?', participantId, eventId)) notFound('Deelnemer niet gevonden');
    if (!teamId && !participantId) bad('Kies een team of deelnemer.');
    const e = { id: id('e_'), points: p, reason: String(reason).slice(0, 200) };
    this.db.run(`INSERT INTO score_events (id, event_id, team_id, participant_id, board, points, reason, kind, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      e.id, eventId, teamId || null, teamId ? null : participantId, teamId ? 'team' : 'individual', p, e.reason, kind === 'bonus' ? 'bonus' : 'correction', actor, this.clock());
    this.audit(eventId, actor, 'adjust', { teamId, participantId, points: p, reason });
    this.notify(eventId);
    return e;
  }

  voidScoreEvent(eventId, actor, scoreEventId, reason) {
    if (!reason) bad('Een reden is verplicht.');
    const r = this.db.run('UPDATE score_events SET voided_at = ?, voided_reason = ? WHERE id = ? AND event_id = ? AND voided_at IS NULL', this.clock(), reason, scoreEventId, eventId);
    if (!r.changes) notFound('Scoreregel niet gevonden of al vervallen');
    this.audit(eventId, actor, 'void_score', { scoreEventId, reason });
    this.notify(eventId);
  }

  scoreboard(eventId) {
    const teams = this.db.all(`SELECT t.id, t.name, t.color, COALESCE(SUM(CASE WHEN s.voided_at IS NULL AND s.board = 'team' THEN s.points END),0) AS points
      FROM teams t LEFT JOIN score_events s ON s.team_id = t.id WHERE t.event_id = ? GROUP BY t.id ORDER BY t.sort, t.name`, eventId);
    const tr = competitionRanks(teams, t => t.points);
    teams.forEach(t => t.rank = tr.get(t));
    teams.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
    const people = this.db.all(`SELECT p.id, p.name, COALESCE(SUM(CASE WHEN s.voided_at IS NULL AND s.board = 'individual' THEN s.points END),0) AS points
      FROM participants p LEFT JOIN score_events s ON s.participant_id = p.id WHERE p.event_id = ? GROUP BY p.id`, eventId);
    const pr = competitionRanks(people, p => p.points);
    people.forEach(p => p.rank = pr.get(p));
    people.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
    return { teams, individuals: people };
  }

  // ---------- captain ----------
  setCaptain(eventId, actor, participantId, { byParticipant } = {}) {
    this.db.tx(() => {
      const m = this.db.get('SELECT m.* FROM memberships m JOIN participants p ON p.id = m.participant_id WHERE m.participant_id = ? AND p.event_id = ?', participantId, eventId) || notFound('Deelnemer zit niet in een team');
      if (byParticipant) {
        const me = this.membership(byParticipant);
        if (!me || !me.is_captain || me.team_id !== m.team_id) deny('Alleen de huidige captain kan de rol overdragen.');
        const st = this.state(eventId);
        if (st.phase === 'open') conflict('Draag de captainrol over als er geen vraag openstaat.');
      }
      this.db.run('UPDATE memberships SET is_captain = 0 WHERE team_id = ?', m.team_id);
      this.db.run('UPDATE memberships SET is_captain = 1 WHERE participant_id = ?', participantId);
      this.audit(eventId, actor, 'captain', { participantId, teamId: m.team_id });
    });
    this.notify(eventId);
  }
}

/** Valideer en normaliseer een antwoord per vraagtype. */
export function validateAnswer(q, answer, db, eventId) {
  const n = q.options.length;
  switch (q.type) {
    case 'mc': { const i = Number(answer); if (!Number.isInteger(i) || i < 0 || i >= n) bad('Ongeldige keuze.'); return i; }
    case 'tf': { const i = Number(answer); if (i !== 0 && i !== 1) bad('Kies waar of niet waar.'); return i; }
    case 'open': { const s = String(answer ?? '').trim(); if (!s) bad('Vul een antwoord in.'); if (s.length > 200) bad('Antwoord is te lang.'); return s; }
    case 'number': { const x = Number(String(answer).replace(',', '.')); if (!Number.isFinite(x)) bad('Vul een getal in.'); return x; }
    case 'order': {
      if (!Array.isArray(answer) || answer.length !== n || new Set(answer).size !== n || answer.some(i => !Number.isInteger(i) || i < 0 || i >= n)) bad('Ongeldige volgorde.');
      return answer;
    }
    case 'match': {
      const m = q.settings.right?.length ?? 0;
      if (!Array.isArray(answer) || answer.length !== n || answer.some(i => !Number.isInteger(i) || i < 0 || i >= m)) bad('Ongeldige koppeling.');
      return answer;
    }
    case 'ranking': {
      const p = db.get('SELECT id FROM participants WHERE id = ? AND event_id = ?', String(answer), eventId);
      if (!p) bad('Kies een deelnemer.');
      return p.id;
    }
    default: bad('Onbekend vraagtype');
  }
}
