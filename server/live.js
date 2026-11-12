// Live spelverloop: state-machine per vraag, inzendingen, scoren en scorebord.
// Alles wat telt gebeurt hier, op de server. Clients krijgen alleen gefilterde views (views.js).
import { id, json } from './db.js';
import { HttpError, bad, deny, notFound } from './auth.js';
import { judgeOpen, speedScore, competitionRanks, pointsForRank, sameArray } from './scoring.js';
import * as M from './modules.js';
import { randomInt } from 'node:crypto';

export const ROULETTE_TASKS = ['Neem een shotje!', 'Neem 3 slokken!', 'Neem een 0.0-shotje!'];

export const ADVICE_TYPES = ['mc', 'tf', 'open', 'number', 'ranking', 'envelope'];
export const CAPTAIN_STREAK = 3;
const conflict = (msg, code = 'conflict') => { throw new HttpError(409, msg, code); };

export const PHASES = ['idle', 'ready', 'open', 'closed', 'revealed', 'scored'];
export const SCREENS = ['lobby', 'round_intro', 'question', 'scoreboard', 'break', 'finale', 'shots_reveal'];

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
    if ('question_id' in patch && patch.question_id !== s.question_id) next.banner = patch.banner ?? null;
    this.db.run(`UPDATE live_state SET screen=?, round_id=?, question_id=?, phase=?, paused=?, open_at=?, deadline=?, paused_at=?, seq=?, message=?, banner=?, updated_at=? WHERE event_id=?`,
      next.screen, next.round_id, next.question_id, next.phase, next.paused, next.open_at, next.deadline, next.paused_at, next.seq, next.message, next.banner ?? null, next.updated_at, eventId);
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
          this.db.run('UPDATE questions SET locked_at = COALESCE(locked_at, ?) WHERE id = ?', t, s.question_id);
          return this.#set(eventId, { phase: 'closed', paused: 0, paused_at: null, deadline: s.deadline && s.deadline < t ? s.deadline : t }, actor, action);
        }
        case 'reveal': {
          if (s.phase !== 'closed') conflict('Sluit de vraag eerst.');
          if (this.question(s.question_id).type === 'shot') conflict('Shots worden samen onthuld nadat alle shots zijn vastgezet (knop “Shotonthulling”).');
          if (this.question(s.question_id).type === 'envelope') conflict('De enveloppen blijven dicht tot de uitslag (knop “Enveloppen openen”).');
          this.autoJudge(s.question_id);
          return this.#set(eventId, { phase: 'revealed' }, actor, action);
        }
        case 'score': {
          if (s.phase !== 'revealed' && s.phase !== 'scored') conflict('Onthul de vraag eerst.');
          this.scoreQuestion(eventId, s.question_id, actor);
          this.judgeAdvice(s.question_id);
          const changes = this.rotateCaptains(eventId, s.question_id, actor);
          return this.#set(eventId, { phase: 'scored', ...(changes.length ? { banner: JSON.stringify({ type: 'captain', changes }) } : {}) }, actor, action);
        }
        case 'goto': {
          // Terug naar een (eerder gespeelde) vraag. Gespeeld: opnieuw tonen met uitslag, zonder opnieuw te openen.
          if (s.phase === 'open') conflict('Sluit eerst de open vraag.');
          const q = this.db.get('SELECT id, round_id, type, voided_at, locked_at FROM questions WHERE id = ? AND event_id = ?', questionId, eventId) || notFound('Vraag niet gevonden');
          if (q.voided_at) conflict('Deze vraag is ongeldig verklaard.');
          const played = q.locked_at || this.db.get('SELECT 1 FROM submissions WHERE question_id = ? LIMIT 1', q.id);
          if (!played) return this.#set(eventId, { screen: 'question', round_id: q.round_id, question_id: q.id, phase: 'ready', open_at: null, deadline: null, paused: 0, paused_at: null }, actor, action);
          const scored = this.db.get('SELECT 1 FROM score_events WHERE question_id = ? AND voided_at IS NULL LIMIT 1', q.id);
          const phase = q.type === 'shot' || q.type === 'envelope' ? 'closed' : scored ? 'scored' : 'revealed';
          if (phase === 'revealed') this.autoJudge(q.id);
          return this.#set(eventId, { screen: 'question', round_id: q.round_id, question_id: q.id, phase, open_at: null, deadline: null, paused: 0, paused_at: null }, actor, action);
        }
        case 'envelopes_open': {
          if (s.phase === 'open') conflict('Sluit eerst de open vraag.');
          const eq = questionId ? this.question(questionId)
            : (() => { const r = this.db.get("SELECT id FROM questions WHERE event_id = ? AND type = 'envelope' AND voided_at IS NULL ORDER BY sort, id LIMIT 1", eventId); return r && this.question(r.id); })();
          if (!eq || eq.type !== 'envelope' || eq.event_id !== eventId) notFound('Er is geen envelop-vraag.');
          if (!eq.locked_at) conflict('De enveloppen zijn nog leeg: speel eerst de envelop-vraag (aan het begin van de avond).');
          const hostName = json(this.db.get('SELECT settings FROM events WHERE id = ?', eventId).settings, {}).rouletteHost?.name;
          M.openEnvelopes(this.db, eventId, eq, t, actor, hostName);
          return this.#set(eventId, { screen: 'envelopes', round_id: eq.round_id, question_id: eq.id, phase: 'closed', open_at: null, deadline: null, paused: 0, paused_at: null }, actor, action);
        }
        case 'shots_reveal': {
          if (s.phase === 'open') conflict('Sluit eerst de open vraag.');
          const rid = roundId || s.round_id;
          const qs = M.shotQuestionsInRound(this.db, rid);
          if (!qs.length) conflict('Deze ronde heeft geen shotvragen.');
          const open = qs.filter(q => !q.locked_at);
          if (open.length) conflict(`Nog niet alle shots zijn vastgezet (${open.length} open). Pas daarna onthullen, anders is het laatste antwoord gratis.`);
          for (const q of qs) this.scoreQuestion(eventId, q.id, actor);
          const r = this.db.get('SELECT settings FROM rounds WHERE id = ?', rid);
          this.db.run('UPDATE rounds SET settings = ? WHERE id = ?', JSON.stringify({ ...json(r.settings, {}), revealedAt: t }), rid);
          return this.#set(eventId, { screen: 'shots_reveal', round_id: rid, question_id: null, phase: 'idle', open_at: null, deadline: null }, actor, action);
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

  /** Vorige (niet-vervallen) vraag vóór de huidige, of null. */
  prevQuestionId(eventId) {
    const s = this.state(eventId);
    if (!s.question_id) return null;
    const list = this.db.all(`SELECT q.id, q.voided_at FROM questions q JOIN rounds r ON r.id = q.round_id WHERE q.event_id = ? ORDER BY r.sort, r.id, q.sort, q.id`, eventId);
    const i = list.findIndex(x => x.id === s.question_id);
    return list.slice(0, Math.max(0, i)).reverse().find(x => !x.voided_at)?.id ?? null;
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
      M.checkModuleSubmit(this.db, q, participant, m);
      const clean = validateAnswer(q, answer, this.db, eventId, m);
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
  verdictFor(q, key, a) {
    if (['ranking', 'shot', 'invest', 'envelope'].includes(q.type) || q.settings.kompaan || key.correct == null) return null;
    switch (q.type) {
      case 'mc': case 'tf': return (Array.isArray(key.correct) ? key.correct.includes(a) : a === key.correct) ? 'correct' : 'wrong';
      case 'open': return judgeOpen(a, [String(key.correct), ...key.accepted]);
      case 'number': return q.scoring === 'closest' ? null : (Math.abs(a - Number(key.correct)) <= (key.tolerance ?? 0) ? 'correct' : 'wrong');
      case 'order': case 'match': return sameArray(a, key.correct) ? 'correct' : 'wrong';
      default: return null;
    }
  }

  autoJudge(qid) {
    const q = this.question(qid); const key = this.answerKey(qid);
    for (const s of this.db.all('SELECT * FROM submissions WHERE question_id = ? AND judged_by IS NULL', qid)) {
      const a = json(s.answer);
      let v = 'wrong';
      if (['ranking', 'shot', 'invest', 'envelope'].includes(q.type) || q.settings.kompaan) v = null;
      else switch (q.type) {
        case 'mc': case 'tf': v = (Array.isArray(key.correct) ? key.correct.includes(a) : a === key.correct) ? 'correct' : 'wrong'; break;
        case 'open': v = judgeOpen(a, [...(key.correct != null ? [String(key.correct)] : []), ...key.accepted]); break;
        case 'number': v = q.scoring === 'closest' ? null : (Math.abs(a - Number(key.correct)) <= (key.tolerance ?? 0) ? 'correct' : 'wrong'); break;
        case 'order': case 'match': v = sameArray(a, key.correct) ? 'correct' : 'wrong'; break;
        default: v = null;
      }
      this.db.run('UPDATE submissions SET verdict = ? WHERE id = ?', v, s.id);
    }
  }

  // ---------- teamadvies ----------
  /** Teamgenoot (geen captain) tikt een advies aan. Telt niet voor punten; de captain beslist. */
  advise(eventId, participant, { questionId, answer }) {
    const t = this.clock();
    this.db.tx(() => {
      const s = this.state(eventId);
      if (s.question_id !== questionId) conflict('Deze vraag is niet (meer) actief.', 'not_active');
      const q = this.question(questionId);
      if (q.scope !== 'team' || !ADVICE_TYPES.includes(q.type) || q.settings.kompaan) bad('Bij deze vraag kun je geen advies geven.');
      const m = this.membership(participant.id);
      if (!m) deny('Je zit nog niet in een team.');
      if (m.is_captain) bad('Jij bent captain: stuur het teamantwoord in.');
      if (s.phase !== 'open' || s.paused || t < s.open_at || (s.deadline && t > s.deadline)) conflict('De vraag is gesloten.', 'closed');
      if (this.db.get('SELECT 1 FROM submissions WHERE question_id = ? AND owner_key = ?', questionId, 't:' + m.team_id)) conflict('Jullie captain heeft al ingestuurd.', 'done');
      const clean = validateAnswer(q, answer, this.db, eventId, m);
      this.db.run(`INSERT INTO advice (question_id, participant_id, team_id, event_id, answer, updated_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(question_id, participant_id) DO UPDATE SET answer = excluded.answer, updated_at = excluded.updated_at`, questionId, participant.id, m.team_id, eventId, JSON.stringify(clean), t);
    });
    this.notify(eventId);
  }

  judgeAdvice(qid) {
    const q = this.question(qid); const key = this.answerKey(qid);
    for (const a of this.db.all('SELECT * FROM advice WHERE question_id = ?', qid))
      this.db.run('UPDATE advice SET verdict = ? WHERE question_id = ? AND participant_id = ?', this.verdictFor(q, key, json(a.answer)), qid, a.participant_id);
  }

  /**
   * Captain-wissel: na CAPTAIN_STREAK foute teamantwoorden op rij van dezelfde captain
   * gaat de rol naar de teamgenoot met de meeste goede adviezen. Uit te zetten per avond.
   */
  /**
   * Shot-roulette: kies op de server één willekeurige aangemelde speler (niet uitgesloten,
   * niet twee keer achter elkaar dezelfde). Geen punten; alleen eer en een shotje.
   */
  roulette(eventId, actor, { task, exclude, host } = {}) {
    const out = this.db.tx(() => {
      const ev = this.db.get('SELECT settings FROM events WHERE id = ?', eventId);
      const settings = json(ev.settings, {});
      const ex = Array.isArray(exclude) ? exclude.map(String).slice(0, 200) : settings.rouletteExclude || [];
      const hs = host && typeof host === 'object' ? { on: !!host.on, name: String(host.name || '').trim().slice(0, 40) || 'Quizmaster' } : settings.rouletteHost || { on: false, name: 'Rinus' };
      if (Array.isArray(exclude) || host) this.db.run('UPDATE events SET settings = ? WHERE id = ?', JSON.stringify({ ...settings, rouletteExclude: ex, rouletteHost: hs }), eventId);
      const hostName = hs.name.toLowerCase();
      let pool = this.db.all(`SELECT p.id, p.name, t.name AS team FROM participants p LEFT JOIN memberships m ON m.participant_id = p.id LEFT JOIN teams t ON t.id = m.team_id
        WHERE p.event_id = ? AND p.joined_at IS NOT NULL ORDER BY p.name`, eventId).filter(p => !ex.includes(p.id) && p.name.toLowerCase() !== hostName);
      // De quizmaster telt één keer mee (ook als hij zich als speler heeft aangemeld onder dezelfde naam).
      if (hs.on) pool.push({ id: 'host', name: hs.name, team: 'Quizmaster' });
      if (!pool.length) bad('Er is niemand om te kiezen. Zijn er spelers aangemeld (en niet allemaal uitgesloten)?');
      const prev = json(this.state(eventId).roulette, null)?.winner?.id;
      const candidates = pool.length > 1 ? pool.filter(p => p.id !== prev) : pool;
      const w = candidates[randomInt(candidates.length)];
      const names = pool.map(p => p.name);
      for (let i = names.length - 1; i > 0; i--) { const j = randomInt(i + 1); [names[i], names[j]] = [names[j], names[i]]; }
      const chosen = String(task || '').trim().slice(0, 80) || ROULETTE_TASKS[0];
      // Wint de quizmaster? Dan de 0.0-variant: hij moet scherp blijven.
      const r = { id: id('r_'), at: this.clock() + 400, task: w.id === 'host' ? ROULETTE_TASKS[2] : chosen, names, winner: { id: w.id, name: w.name, team: w.team || null } };
      const s = this.state(eventId);
      this.db.run('UPDATE live_state SET roulette = ?, seq = ?, updated_at = ? WHERE event_id = ?', JSON.stringify(r), s.seq + 1, this.clock(), eventId);
      this.audit(eventId, actor, 'roulette', { winner: w.name, task: r.task });
      return r;
    });
    this.notify(eventId);
    return out;
  }

  /** Dragons: de quizmaster als extra investeerder. Telt mee in de totalen, niet in teampunten van een eigen team. */
  hostInvest(eventId, actor, answer) {
    this.db.tx(() => {
      const s = this.state(eventId);
      const q = s.question_id ? this.question(s.question_id) : null;
      if (!q || q.type !== 'invest') bad('Er staat geen Dragons-vraag klaar.');
      if (!['open', 'closed'].includes(s.phase)) conflict('Investeren kan alleen terwijl de Dragons-vraag open of gesloten (nog niet onthuld) is.');
      const clean = M.validateModuleAnswer(this.db, q, answer, eventId, null);
      this.db.run(`INSERT INTO submissions (id, event_id, question_id, owner_key, participant_id, team_id, answer, received_at) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(question_id, owner_key) DO UPDATE SET answer = excluded.answer, received_at = excluded.received_at`, id('s_'), eventId, q.id, 'host', null, null, JSON.stringify(clean), this.clock());
      this.audit(eventId, actor, 'host_invest', clean);
    });
    this.notify(eventId);
  }

  /** Envelop van de quizmaster: zijn voorspelde eindvolgorde (geen punten). */
  hostEnvelope(eventId, actor, answer) {
    this.db.tx(() => {
      const s = this.state(eventId);
      const q = s.question_id ? this.question(s.question_id) : null;
      if (!q || q.type !== 'envelope') bad('Er staat geen envelop-vraag klaar.');
      if (q.settings.envelopes) conflict('De enveloppen zijn al open.');
      const clean = M.validateModuleAnswer(this.db, q, answer, eventId, null);
      this.db.run(`INSERT INTO submissions (id, event_id, question_id, owner_key, participant_id, team_id, answer, received_at) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(question_id, owner_key) DO UPDATE SET answer = excluded.answer, received_at = excluded.received_at`, id('s_'), eventId, q.id, 'host', null, null, JSON.stringify(clean), this.clock());
      this.audit(eventId, actor, 'host_envelope', null);
    });
    this.notify(eventId);
  }

  rouletteClose(eventId, actor) {
    const s = this.state(eventId);
    this.db.run('UPDATE live_state SET roulette = NULL, seq = ?, updated_at = ? WHERE event_id = ?', s.seq + 1, this.clock(), eventId);
    this.notify(eventId);
  }

  rotateCaptains(eventId, qid, actor) {
    const ev = this.db.get('SELECT settings FROM events WHERE id = ?', eventId);
    if (json(ev.settings, {}).autoCaptain === false) return [];
    const q = this.question(qid);
    if (q.scope !== 'team' || q.scoring === 'closest' || !ADVICE_TYPES.includes(q.type)) return [];
    const changes = [];
    for (const sub of this.db.all('SELECT * FROM submissions WHERE question_id = ? AND team_id IS NOT NULL', qid)) {
      const cap = this.db.get('SELECT m.*, p.name FROM memberships m JOIN participants p ON p.id = m.participant_id WHERE m.team_id = ? AND m.is_captain = 1', sub.team_id);
      if (!cap || cap.participant_id !== sub.participant_id) continue;
      const recent = this.db.all(`SELECT s.verdict FROM submissions s JOIN questions q ON q.id = s.question_id
        WHERE s.team_id = ? AND s.participant_id = ? AND q.scope = 'team' AND q.voided_at IS NULL AND s.verdict IS NOT NULL AND s.received_at >= ?
        ORDER BY s.received_at DESC LIMIT ?`, sub.team_id, cap.participant_id, cap.captain_since ?? 0, CAPTAIN_STREAK);
      if (recent.length < CAPTAIN_STREAK || recent.some(r => r.verdict !== 'wrong')) continue;
      const next = this.db.get(`SELECT m.participant_id, p.name,
          (SELECT COUNT(*) FROM advice a WHERE a.participant_id = m.participant_id AND a.verdict = 'correct') AS good
        FROM memberships m JOIN participants p ON p.id = m.participant_id
        WHERE m.team_id = ? AND m.participant_id <> ? AND p.joined_at IS NOT NULL ORDER BY good DESC, p.name LIMIT 1`, sub.team_id, cap.participant_id);
      if (!next) continue;
      this.setCaptain(eventId, actor || 'auto', next.participant_id);
      const team = this.db.get('SELECT name FROM teams WHERE id = ?', sub.team_id).name;
      changes.push({ team, from: cap.name, to: next.name, good: next.good });
      this.audit(eventId, actor, 'captain_auto', { teamId: sub.team_id, from: cap.participant_id, to: next.participant_id });
    }
    return changes;
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
      const addM = (teamId, participantId, board, suffix, points, reason) => this.db.run(`INSERT INTO score_events (id, event_id, team_id, participant_id, board, question_id, source_key, points, reason, kind, created_by, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, id('e_'), eventId, board === 'team' ? teamId : null, board === 'individual' ? participantId : null, board, qid, `q:${qid}:${suffix}`, points, reason, 'auto', actor || null, t);
      if (M.scoreModule(this.db, { ...q, event_id: eventId }, key, subs, addM)) return;
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

  // ---------- Buitentas ----------
  scoreMission(eventId, actor, missionId) {
    const res = this.db.tx(() => {
      const t = this.clock();
      this.db.run("UPDATE score_events SET voided_at = ?, voided_reason = 'opnieuw gescoord' WHERE event_id = ? AND source_key LIKE ? AND voided_at IS NULL", t, eventId, `m:${missionId}:%`);
      return M.scoreMission(this.db, eventId, missionId, (teamId, key, points, reason) => this.db.run(`INSERT INTO score_events (id, event_id, team_id, board, source_key, points, reason, kind, created_by, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`, id('e_'), eventId, teamId, 'team', key, points, reason, 'auto', actor, t));
    });
    this.audit(eventId, actor, 'score_mission', { missionId });
    this.notify(eventId);
    return res;
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
      this.db.run('UPDATE memberships SET is_captain = 1, captain_since = ? WHERE participant_id = ?', this.clock(), participantId);
      this.audit(eventId, actor, 'captain', { participantId, teamId: m.team_id });
    });
    this.notify(eventId);
  }
}

/** Valideer en normaliseer een antwoord per vraagtype. */
export function validateAnswer(q, answer, db, eventId, membership) {
  const mod = M.validateModuleAnswer(db, q, answer, eventId, membership);
  if (mod !== undefined) return mod;
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
      const top = q.settings.top || 1;
      if (top > 1) {
        const n = Math.min(top, db.get('SELECT COUNT(*) AS n FROM participants WHERE event_id = ?', eventId).n);
        if (!Array.isArray(answer) || answer.length !== n || new Set(answer).size !== n) bad(`Kies ${n} verschillende namen, in volgorde.`);
        return answer.map(a => { const p = db.get('SELECT id FROM participants WHERE id = ? AND event_id = ?', String(a), eventId); if (!p) bad('Onbekende naam.'); return p.id; });
      }
      const p = db.get('SELECT id FROM participants WHERE id = ? AND event_id = ?', String(answer), eventId);
      if (!p) bad('Kies een deelnemer.');
      return p.id;
    }
    default: bad('Onbekend vraagtype');
  }
}
