// Rolgefilterde views. Hier wordt bepaald wat elke client mag zien.
// Regel: antwoordsleutels, verborgen inzendingen en geheime stemmen gaan nooit naar een client
// die ze (nog) niet mag zien — ook niet "verstopt" in de payload.
import { json } from './db.js';
import { can } from './auth.js';
import * as M from './modules.js';
import * as MSG from './messages.js';

const AFTER_CLOSE = ['closed', 'revealed', 'scored'];
const REVEALED = ['revealed', 'scored'];

export function eventInfo(ev) {
  const settings = json(ev.settings, {});
  return { id: ev.id, name: ev.name, subtitle: ev.subtitle, mode: ev.mode, isDemo: !!ev.is_demo, status: ev.status, startsAt: ev.starts_at,
    durationTarget: ev.duration_target, durationMax: ev.duration_max, theme: settings.theme || 'koper', sound: settings.sound ?? true };
}

function roundInfo(db, roundId) {
  if (!roundId) return null;
  const r = db.get('SELECT id, kind, title, instructions, supplies, minutes FROM rounds WHERE id = ?', roundId);
  if (!r) return null;
  r.questionCount = db.get('SELECT COUNT(*) AS n FROM questions WHERE round_id = ? AND voided_at IS NULL', roundId).n;
  return r;
}

/** Publieke vraag: keuzes pas zichtbaar vanaf de gezamenlijke servertijd van openen. */
export function publicQuestion(live, s, t) {
  if (!s.question_id) return null;
  const q = live.question(s.question_id);
  if (!q) return null;
  const visible = (s.phase === 'open' && t >= s.open_at) || AFTER_CLOSE.includes(s.phase);
  const pos = live.db.all('SELECT id FROM questions WHERE round_id = ? AND voided_at IS NULL ORDER BY sort, id', q.round_id).map(r => r.id);
  return {
    id: q.id, type: q.type, scope: q.scope, scoring: q.scoring, visible,
    // Vraagtekst en keuzes openen tegelijk op de geplande servertijd (eerlijke start).
    prompt: visible ? q.prompt : null, quote: visible ? q.quote : null, context: visible ? q.context : null,
    seconds: q.seconds, points: q.points, allowBet: !!q.allow_bet, isExample: !!q.is_example,
    media: visible && q.media_id ? { id: q.media_id } : null,
    options: visible ? (q.type === 'envelope' ? envelopeOptions(live.db, q.event_id) : q.options) : null,
    right: visible && q.type === 'match' ? (q.settings.right || []) : null,
    kompaan: !!q.settings.kompaan,
    top: q.type === 'ranking' ? (q.settings.top || 1) : null,
    candidates: visible && ['ranking', 'career'].includes(q.type) ? live.db.all('SELECT id, name FROM participants WHERE event_id = ? ORDER BY name', q.event_id) : null,
    teams: visible && ['shot', 'invest'].includes(q.type) ? live.db.all('SELECT id, name FROM teams WHERE event_id = ? ORDER BY sort, name', q.event_id) : null,
    pitch: q.type === 'invest' && q.settings.pitch ? { team: q.settings.pitchTeam ? live.db.get('SELECT id, name FROM teams WHERE id = ?', q.settings.pitchTeam) : null } : null,
    budget: q.type === 'invest' ? (q.settings.budget || M.DRAGONS_BUDGET) : null, step: q.type === 'invest' ? M.DRAGONS_STEP : null,
    shotNumber: q.type === 'shot' ? q.settings.shotNumber : null,
    pledge: q.type === 'envelope' ? !!q.settings.pledge : null,
    // Carrière: alleen de hints die al op tv staan, nooit de volgende.
    career: q.type === 'career' ? { clues: visible ? q.settings.clues.slice(0, M.careerShown(q, s, t)) : [], total: q.settings.clues.length, auto: q.settings.clueSeconds || 0,
      scale: q.settings.scale, ownTeam: !!q.settings.ownTeam } : null,
    // Allergenen moeten vóór het proeven controleerbaar zijn, ook al verraadt dat iets.
    allergens: q.type === 'shot' ? (live.db.get('SELECT allergens FROM shots WHERE event_id = ? AND number = ?', q.event_id, q.settings.shotNumber)?.allergens ?? 'nog niet ingevuld — vraag de organisatie') : null,
    number: pos.indexOf(q.id) + 1, of: pos.length,
  };
}

function revealInfo(live, s) {
  if (!REVEALED.includes(s.phase) || !s.question_id) return null;
  const q = live.question(s.question_id); const key = live.answerKey(s.question_id);
  const subs = live.db.all('SELECT answer, verdict, elapsed_ms, participant_id, team_id FROM submissions WHERE question_id = ?', s.question_id);
  const out = { correct: key.correct, explanation: key.explanation, total: subs.length, correctCount: subs.filter(x => x.verdict === 'correct').length };
  if (q.type === 'mc' || q.type === 'tf') {
    const n = q.type === 'tf' ? 2 : q.options.length;
    out.distribution = Array.from({ length: n }, (_, i) => subs.filter(x => json(x.answer) === i).length);
  }
  if (q.scoring === 'speed') {
    out.fastest = live.db.all(`SELECT p.name, s.elapsed_ms FROM submissions s JOIN participants p ON p.id = s.participant_id
      WHERE s.question_id = ? AND s.verdict = 'correct' ORDER BY s.elapsed_ms LIMIT 3`, s.question_id).map(r => ({ name: r.name, seconds: +(r.elapsed_ms / 1000).toFixed(2) }));
  }
  Object.assign(out, M.revealModule(live.db, { ...q, event_id: q.event_id }) || {});
  if (q.type === 'number') out.answers = subs.length <= 12 ? live.db.all(`SELECT t.name, s.answer FROM submissions s LEFT JOIN teams t ON t.id = s.team_id WHERE s.question_id = ?`, s.question_id).map(r => ({ name: r.name, value: json(r.answer) })) : null;
  return out;
}

function envelopeOptions(db, eventId) {
  const n = db.get('SELECT COUNT(*) AS n FROM teams WHERE event_id = ?', eventId).n;
  return Array.from({ length: n }, (_, i) => i === 0 ? 'Winnaar (1e plek)' : i === n - 1 ? `Laatste (${n}e plek)` : `${i + 1}e plek`);
}

function liveInfo(live, s, t) {
  return { screen: s.screen, phase: s.phase, paused: !!s.paused, seq: s.seq, openAt: s.open_at, deadline: s.deadline,
    pausedAt: s.paused_at, message: s.message, round: roundInfo(live.db, s.round_id), banner: s.banner ? json(s.banner) : null, roulette: s.roulette ? json(s.roulette) : null,
    envelopes: s.screen === 'envelopes' && s.question_id ? (live.question(s.question_id)?.settings.envelopes ?? null) : null };
}

function teamsWithMembers(db, eventId, online) {
  const teams = db.all('SELECT id, name, color, outfit, sort FROM teams WHERE event_id = ? ORDER BY sort, name', eventId);
  const members = db.all(`SELECT p.id, p.name, p.joined_at, m.team_id, m.is_captain FROM participants p LEFT JOIN memberships m ON m.participant_id = p.id
    WHERE p.event_id = ? ORDER BY p.name`, eventId);
  for (const tm of teams) tm.members = members.filter(m => m.team_id === tm.id).map(m => ({ id: m.id, name: m.name, isCaptain: !!m.is_captain, joined: !!m.joined_at, online: online.has(m.id) }));
  return { teams, unassigned: members.filter(m => !m.team_id).map(m => ({ id: m.id, name: m.name, joined: !!m.joined_at, online: online.has(m.id) })) };
}

function counts(live, eventId, s) {
  if (!s.question_id) return null;
  const q = live.question(s.question_id);
  const submitted = live.db.get("SELECT COUNT(*) AS n FROM submissions WHERE question_id = ? AND owner_key != 'host'", s.question_id).n;
  const expected = q.scope === 'team'
    ? live.db.get('SELECT COUNT(*) AS n FROM teams WHERE event_id = ?', eventId).n
    : live.db.get('SELECT COUNT(*) AS n FROM participants WHERE event_id = ? AND joined_at IS NOT NULL', eventId).n;
  const sitOut = q.type === 'invest' && q.settings.pitch && q.settings.pitchTeam ? 1 : 0; // het pitchende team biedt niet
  return { submitted, expected: Math.max(0, expected - sitOut) };
}

function boardFor(live, eventId, { topTeams = 100, topPeople = 10, meId } = {}) {
  const sb = live.scoreboard(eventId);
  const me = meId ? sb.individuals.find(p => p.id === meId) : null;
  return { teams: sb.teams.slice(0, topTeams), individuals: sb.individuals.slice(0, topPeople).map(({ id, ...r }) => r), me: me ? { rank: me.rank, points: me.points, of: sb.individuals.length } : null };
}

// ---------- speler ----------
export function playerView(live, { participant, event }, online, t = live.clock()) {
  const db = live.db; const s = live.state(event.id);
  const m = live.membership(participant.id);
  const team = m ? db.get('SELECT id, name, outfit FROM teams WHERE id = ?', m.team_id) : null;
  const q = publicQuestion(live, s, t);
  let mine = null, result = null, advice = null;
  if (q) {
    const owner = q.scope === 'team' ? (m ? 't:' + m.team_id : null) : 'p:' + participant.id;
    const sub = owner ? db.get('SELECT s.*, p.name AS by_name FROM submissions s LEFT JOIN participants p ON p.id = s.participant_id WHERE question_id = ? AND owner_key = ?', q.id, owner) : null;
    if (sub) {
      mine = { answer: json(sub.answer), bet: sub.bet, receivedAt: sub.received_at, elapsedMs: sub.elapsed_ms, by: sub.by_name };
      if (REVEALED.includes(s.phase)) {
        mine.verdict = sub.verdict;
        const pts = db.get('SELECT COALESCE(SUM(points),0) AS p, COUNT(*) AS n FROM score_events WHERE source_key = ? AND voided_at IS NULL', `q:${q.id}:${owner}`);
        mine.points = s.phase === 'scored' ? pts.p : null;
      }
    }
    result = revealInfo(live, s);
    // Teamadvies: het hele team ziet wie wat aantikt (pas zichtbaar als de vraag zichtbaar is).
    if (m && q.scope === 'team' && q.visible) advice = db.all(`SELECT a.participant_id AS id, p.name, a.answer FROM advice a JOIN participants p ON p.id = a.participant_id
      WHERE a.question_id = ? AND a.team_id = ? ORDER BY a.updated_at`, q.id, m.team_id).map(r => ({ id: r.id, name: r.name, answer: json(r.answer), mine: r.id === participant.id }));
  }
  const showBoard = ['scoreboard', 'finale'].includes(s.screen);
  return {
    kind: 'player', serverNow: t, event: eventInfo(event),
    me: { id: participant.id, name: participant.name, teamId: team?.id ?? null, teamName: team?.name ?? null, isCaptain: !!m?.is_captain, joinedAt: participant.joined_at },
    team: team ? { ...team, members: db.all(`SELECT p.id, p.name, m.is_captain FROM memberships m JOIN participants p ON p.id = m.participant_id WHERE m.team_id = ? ORDER BY p.name`, team.id)
      .map(x => ({ id: x.id, name: x.name, isCaptain: !!x.is_captain, online: online.has(x.id) })) } : null,
    live: liveInfo(live, s, t), question: q, mine, result, advice,
    scoreboard: showBoard ? boardFor(live, event.id, { topTeams: 100, topPeople: 5, meId: participant.id }) : null,
    shotsReveal: s.screen === 'shots_reveal' ? M.shotsRevealData(db, event.id, s.round_id) : null,
    messages: MSG.playerMessages(db, event.id),
    pitchStatus: q?.pitch && m ? M.pitchStatus(db, live.question(q.id), 't:' + m.team_id, m.team_id) : null,
    ownShot: q?.type === 'shot' && team ? !!db.get('SELECT 1 FROM shots WHERE team_id = ? AND number = ?', team.id, q.shotNumber) : false,
    kompaan: q?.kompaan && team ? { pair: M.kompaanPair(db, { ...live.question(q.id), event_id: event.id }, team.id).map(p => ({ id: p.id, name: p.name })) } : null,
    prep: prepView(live, event, participant, team),
  };
}

// ---------- tv ----------
export function displayView(live, event, online, joinUrl, t = live.clock()) {
  const s = live.state(event.id);
  const { teams } = teamsWithMembers(live.db, event.id, online);
  return {
    kind: 'display', serverNow: t, event: eventInfo(event), joinCode: event.join_code, joinUrl,
    teams: teams.map(tm => ({ id: tm.id, name: tm.name, color: tm.color, size: tm.members.length, joined: tm.members.filter(m => m.joined).length, online: tm.members.filter(m => m.online).length, members: tm.members.map(m => ({ name: m.name, online: m.online })) })),
    live: liveInfo(live, s, t), question: publicQuestion(live, s, t), counts: counts(live, event.id, s), result: revealInfo(live, s),
    scoreboard: ['scoreboard', 'finale'].includes(s.screen) || s.phase === 'scored' ? boardFor(live, event.id, { topTeams: 10, topPeople: 10 }) : null,
    shotsReveal: s.screen === 'shots_reveal' ? M.shotsRevealData(live.db, event.id, s.round_id) : null,
  };
}

// ---------- staf ----------
export function staffView(live, { event, role, grant }, online, joinUrl, t = live.clock()) {
  const db = live.db; const s = live.state(event.id);
  const full = can(role, 'content.read');
  const host = can(role, 'live.control');
  const { teams, unassigned } = teamsWithMembers(db, event.id, online);
  const rounds = db.all('SELECT * FROM rounds WHERE event_id = ? ORDER BY sort, id', event.id).map(r => ({ ...r, settings: json(r.settings, {}) }));
  const qs = db.all('SELECT * FROM questions WHERE event_id = ? ORDER BY sort, id', event.id);
  const keys = full ? new Map(db.all('SELECT k.* FROM answer_keys k JOIN questions q ON q.id = k.question_id WHERE q.event_id = ?', event.id).map(k => [k.question_id, k])) : null;
  const played = new Set(db.all('SELECT DISTINCT question_id FROM submissions WHERE event_id = ?', event.id).map(r => r.question_id));
  for (const r of rounds) {
    const list = qs.filter(q => q.round_id === r.id);
    r.questionCount = list.length;
    r.sealed = !!r.settings.sealed;
    if (r.sealed && !full) r.instructions = null; // verzegeld: ook de uitleg blijft dicht voor wie geen inhoud mag zien
    if (full || host) {
      r.questions = list.map(q => {
        const base = { id: q.id, type: q.type, scope: q.scope, scoring: q.scoring, seconds: q.seconds, points: q.points, sort: q.sort, voided: !!q.voided_at, played: played.has(q.id), isExample: !!q.is_example, sealed: r.sealed };
        if (r.sealed || (!full && !can(role, 'live.prompts'))) return base;
        Object.assign(base, { prompt: q.prompt, quote: q.quote, context: q.context, options: json(q.options, []), allowBet: !!q.allow_bet, mediaId: q.media_id, settings: json(q.settings, {}) });
        if (full) { const k = keys.get(q.id); base.key = k ? { correct: json(k.correct), accepted: json(k.accepted, []), explanation: k.explanation, tolerance: k.tolerance } : null; }
        return base;
      });
    }
  }
  const view = {
    kind: 'staff', role, roleLabel: grant.label, serverNow: t, event: { ...eventInfo(event), joinCode: event.join_code, joinUrl, settings: (({ questionnaire, dossier, ...rest }) => full ? { ...rest, questionnaire, dossier } : rest)(json(event.settings, {})) },
    perms: { content: can(role, 'content.write'), answers: full, live: host, scores: can(role, 'scores.write'), people: can(role, 'people.write'), roles: can(role, 'roles.manage') },
    teams: teams.map(tm => ({ ...tm, members: tm.members })), unassigned,
    rounds, live: liveInfo(live, s, t), counts: counts(live, event.id, s),
    plannedMinutes: rounds.reduce((a, r) => a + (r.minutes || 0), 0),
    readiness: readiness(db, event.id, full),
    // Wie moet nog iets doen? Alleen ja/nee per speler, nooit inhoud (ook veilig voor de spoilervrije organisator).
    progress: can(role, 'progress.read') ? {
      people: db.all(`SELECT p.name, t.name AS team, p.joined_at IS NOT NULL AS joined, COALESCE(json_extract(p.profile, '$.done'), 0) = 1 AS dossier,
        EXISTS (SELECT 1 FROM ranking_votes v WHERE v.voter_id = p.id) AS voted FROM participants p LEFT JOIN memberships m ON m.participant_id = p.id LEFT JOIN teams t ON t.id = m.team_id
        WHERE p.event_id = ? ORDER BY t.sort, p.name`, event.id).map(x => ({ name: x.name, team: x.team, joined: !!x.joined, dossier: !!x.dossier, voted: !!x.voted })),
      shots: db.all(`SELECT t.name, EXISTS (SELECT 1 FROM shots s WHERE s.team_id = t.id AND COALESCE(s.name, '') <> '') AS done FROM teams t WHERE t.event_id = ? ORDER BY t.sort`, event.id).map(x => ({ team: x.name, done: !!x.done })),
    } : null,
    nextQuestionId: host ? live.nextQuestionId(event.id) : null,
    prevQuestionId: host ? live.prevQuestionId(event.id) : null,
    scoreboard: boardFor(live, event.id, { topTeams: 100, topPeople: 100 }),
  };
  const sealedNow = s.question_id ? !!json(db.get('SELECT r.settings FROM questions q JOIN rounds r ON r.id = q.round_id WHERE q.id = ?', s.question_id)?.settings, {}).sealed : false;
  if (host || full) {
    view.question = publicQuestion(live, s, t);
    view.sealed = sealedNow;
    if (view.question?.career) view.careerAll = live.question(view.question.id).settings.clues;
    if (view.question?.pitch) { const pq = live.question(view.question.id); view.pitchStatus = M.pitchStatus(db, pq, 'host', null);
      view.pitchDone = M.pitchQuestions(db, pq.round_id).filter(p => p.id !== pq.id && p.settings.pitchTeam).map(p => p.settings.pitchTeam); }
    const env = db.get("SELECT id FROM questions WHERE event_id = ? AND type = 'envelope' AND voided_at IS NULL ORDER BY sort, id LIMIT 1", event.id);
    if (env) { const eq = live.question(env.id); view.envelope = { id: eq.id, filled: !!eq.locked_at, opened: !!eq.settings.envelopes,
      count: db.get("SELECT COUNT(*) AS n FROM submissions WHERE question_id = ? AND owner_key != 'host'", eq.id).n,
      hostDone: !!db.get("SELECT 1 FROM submissions WHERE question_id = ? AND owner_key = 'host'", eq.id) }; }
    // Host ziet de sleutel van de actieve vraag pas na sluiten; inhoudsbeheer altijd.
    if (s.question_id && (sealedNow ? REVEALED.includes(s.phase) : (full || (host && AFTER_CLOSE.includes(s.phase))))) {
      const k = live.answerKey(s.question_id);
      view.currentKey = { correct: k.correct, accepted: k.accepted, explanation: k.explanation, tolerance: k.tolerance };
    }
    if (s.question_id) {
      const subs = db.all(`SELECT s.*, p.name AS by_name, tm.name AS team_name FROM submissions s LEFT JOIN participants p ON p.id = s.participant_id
        LEFT JOIN teams tm ON tm.id = s.team_id WHERE s.question_id = ? ORDER BY s.received_at`, s.question_id);
      const cq = live.question(s.question_id);
      const envClosed = cq?.type === 'envelope' && !cq.settings.envelopes; // verzegeld, ook voor de host
      const showAnswers = envClosed ? false : sealedNow ? AFTER_CLOSE.includes(s.phase) : full || AFTER_CLOSE.includes(s.phase);
      view.submissions = subs.map(x => ({ id: x.id, owner: x.owner_key, by: x.owner_key === 'host' ? 'Quizmaster' : x.by_name, team: x.team_name, elapsedMs: x.elapsed_ms, bet: x.bet,
        answer: showAnswers ? json(x.answer) : undefined, verdict: showAnswers ? x.verdict : undefined, manual: !!x.judged_by }));
    }
    view.result = revealInfo(live, s);
    view.scoreLog = db.all(`SELECT e.*, t.name AS team_name, p.name AS participant_name FROM score_events e LEFT JOIN teams t ON t.id = e.team_id
      LEFT JOIN participants p ON p.id = e.participant_id WHERE e.event_id = ? ORDER BY e.created_at DESC LIMIT 200`, event.id)
      .map(e => ({ id: e.id, team: e.team_name, participant: e.participant_name, board: e.board, points: e.points, reason: e.reason, kind: e.kind, at: e.created_at, voided: !!e.voided_at, voidedReason: e.voided_reason, questionId: e.question_id }));
  }
  if (can(role, 'secrets.read')) {
    view.shots = db.all('SELECT s.*, t.name AS team FROM shots s JOIN teams t ON t.id = s.team_id WHERE s.event_id = ? ORDER BY s.number IS NULL, s.number, t.name', event.id)
      .map(x => ({ ...x, accepted_flavors: json(x.accepted_flavors, []), accepted_bases: json(x.accepted_bases, []) }));
    view.shotWarnings = M.shotWarnings(db, event.id);
    view.questionnaire = questionnaireOverview(db, event);
    view.messages = MSG.staffMessages(db, event.id);
    view.rankingTotals = db.all("SELECT id, prompt FROM questions WHERE event_id = ? AND type = 'ranking'", event.id).map(q => ({ id: q.id, prompt: q.prompt, ...M.rankingTotals(db, q.id) }));
  }
  if (host || full) {
    view.missions = db.all('SELECT * FROM missions WHERE event_id = ? ORDER BY sort, title', event.id).map(m => ({ ...m,
      evidence: db.all('SELECT e.team_id, e.value, e.note, e.media_id, e.measured, e.checked FROM evidence e WHERE e.mission_id = ?', m.id) }));
    view.shotRounds = db.all("SELECT r.id, r.title, r.settings FROM rounds r WHERE r.event_id = ? AND EXISTS (SELECT 1 FROM questions q WHERE q.round_id = r.id AND q.type = 'shot')", event.id)
      .map(r => { const qs = M.shotQuestionsInRound(db, r.id); return { id: r.id, title: r.title, total: qs.length, locked: qs.filter(q => q.locked_at).length, revealed: !!json(r.settings, {}).revealedAt }; });
  }
  if (s.screen === 'shots_reveal' && (host || full)) view.shotsReveal = M.shotsRevealData(db, event.id, s.round_id);
  if (can(role, 'roles.manage')) view.grants = db.all('SELECT id, role, label, revoked, created_at FROM role_grants WHERE event_id = ? ORDER BY created_at', event.id);
  return view;
}

/** Gereedheid: alleen tellingen, dus ook veilig voor de spoilervrije organisator. */
/** Alle antwoorden op de vragenlijst vooraf, per vraag (alleen voor wie inhoud mag zien). */
function questionnaireOverview(db, event) {
  const questions = (json(event.settings, {}).questionnaire || []).filter(q => q.type !== 'section');
  const people = db.all(`SELECT p.id, p.name, p.profile, t.name AS team FROM participants p LEFT JOIN memberships m ON m.participant_id = p.id LEFT JOIN teams t ON t.id = m.team_id
    WHERE p.event_id = ? ORDER BY p.name`, event.id).map(p => ({ id: p.id, name: p.name, team: p.team, prof: json(p.profile, {}) }));
  return {
    questions: questions.map(q => {
      const fmt = a => q.type === 'muchacho' ? `${people.find(x => x.id === a?.pick)?.name ?? '?'}${a?.why ? ' — ' + a.why : ''}` : q.type === 'scale' ? `${a}/10` : q.type === 'number' && q.unit ? `${q.unit} ${a}` : String(a);
      const answers = people.filter(p => p.prof.answers?.[q.id] != null).map(p => ({ name: p.name, team: p.team, answer: fmt(p.prof.answers[q.id]) }));
      let tally = null;
      if (q.type === 'muchacho') { const c = new Map(); for (const p of people) { const pick = p.prof.answers?.[q.id]?.pick; if (pick) c.set(pick, (c.get(pick) || 0) + 1); }
        tally = [...c].map(([id, n]) => ({ name: people.find(x => x.id === id)?.name ?? '?', n })).sort((a, b) => b.n - a.n); }
      if (q.type === 'scale' || q.type === 'number') { const xs = answers.map(a => Number(String(people.find(p => p.name === a.name).prof.answers[q.id]))).filter(Number.isFinite); if (xs.length) tally = [{ name: 'gemiddeld', n: Math.round(xs.reduce((s, x) => s + x, 0) / xs.length * 10) / 10 }]; }
      return { ...q, answers, tally };
    }),
    stories: people.filter(p => p.prof.story || p.prof.limits).map(p => ({ name: p.name, story: p.prof.story || '', limits: p.prof.limits || '' })),
    filled: people.filter(p => p.prof.done).length, total: people.length,
  };
}

export function readiness(db, eventId, full) {
  const one = (sql, ...p) => db.get(sql, ...p).n;
  const r = {
    participants: one('SELECT COUNT(*) AS n FROM participants WHERE event_id = ?', eventId),
    joined: one('SELECT COUNT(*) AS n FROM participants WHERE event_id = ? AND joined_at IS NOT NULL', eventId),
    questionnaireDone: one("SELECT COUNT(*) AS n FROM participants WHERE event_id = ? AND json_extract(profile, '$.done') = 1", eventId),
    teams: one('SELECT COUNT(*) AS n FROM teams WHERE event_id = ?', eventId),
    teamsWithoutCaptain: one('SELECT COUNT(*) AS n FROM teams t WHERE t.event_id = ? AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.team_id = t.id AND m.is_captain = 1)', eventId),
    shotsSubmitted: one("SELECT COUNT(*) AS n FROM shots WHERE event_id = ? AND COALESCE(name,'') <> ''", eventId),
    missionsDone: one("SELECT COUNT(*) AS n FROM evidence WHERE event_id = ? AND mission_id IS NOT NULL AND (COALESCE(value,'') <> '' OR media_id IS NOT NULL)", eventId),
    rankingVotes: one('SELECT COUNT(DISTINCT voter_id) AS n FROM ranking_votes WHERE event_id = ?', eventId),
    missions: one('SELECT COUNT(*) AS n FROM missions WHERE event_id = ?', eventId),
    questions: one('SELECT COUNT(*) AS n FROM questions WHERE event_id = ?', eventId),
    exampleQuestions: one('SELECT COUNT(*) AS n FROM questions WHERE event_id = ? AND is_example = 1', eventId),
    questionsWithoutAnswer: one(`SELECT COUNT(*) AS n FROM questions q LEFT JOIN answer_keys k ON k.question_id = q.id
      JOIN rounds r ON r.id = q.round_id
      WHERE q.event_id = ? AND q.type NOT IN ('ranking', 'shot', 'invest', 'envelope') AND COALESCE(r.judging, '') = '' AND COALESCE(json_extract(q.settings, '$.kompaan'), 0) <> 1 AND (k.correct IS NULL OR k.correct = 'null')`, eventId),
    missingMedia: one(`SELECT COUNT(*) AS n FROM questions WHERE event_id = ? AND json_extract(settings, '$.needsMedia') = 1 AND media_id IS NULL`, eventId),
  };
  return r;
}

// ---------- voorbereiding (speler) ----------
function prepView(live, event, participant, team) {
  const db = live.db; const settings = json(event.settings, {});
  const cur = live.state(event.id).question_id;
  const people = db.all('SELECT id, name FROM participants WHERE event_id = ? ORDER BY name', event.id);
  const ranking = db.all(`SELECT q.id, q.prompt, q.locked_at, v.choice_id, v.id AS vid FROM questions q LEFT JOIN ranking_votes v ON v.question_id = q.id AND v.voter_id = ?
    WHERE q.event_id = ? AND q.type = 'ranking' AND q.voided_at IS NULL ORDER BY q.sort, q.id`, participant.id, event.id)
    .map(r => ({ id: r.id, prompt: r.prompt, voted: !!r.vid, choiceId: r.choice_id, closed: !!r.locked_at || r.id === cur || !!db.get('SELECT 1 FROM submissions WHERE question_id = ? LIMIT 1', r.id) }));
  const shot = team && settings.drinks !== false ? db.get('SELECT name, flavor, base, ingredients, allergens, story, amount, number, updated_by FROM shots WHERE team_id = ?', team.id) : null;
  const hasShotRound = settings.drinks !== false && !!db.get("SELECT 1 FROM rounds WHERE event_id = ? AND kind = 'shots'", event.id);
  const missions = db.all('SELECT id, title, description, kind, target, unit, scored_at FROM missions WHERE event_id = ? ORDER BY sort, title', event.id)
    .map(m => { const e = team ? db.get('SELECT value, note, media_id, checked FROM evidence WHERE mission_id = ? AND team_id = ?', m.id, team.id) : null;
      return { id: m.id, title: m.title, description: m.description, kind: m.kind, target: m.target, unit: m.unit, closed: !!m.scored_at, mine: e ? { value: e.value, note: e.note, hasPhoto: !!e.media_id, checked: !!e.checked } : null }; });
  const profile = json(participant.profile, {});
  return { ranking, candidates: people.filter(p => settings.selfVote || p.id !== participant.id), profile: { story: profile.story || '', limits: profile.limits || '', answers: profile.answers || {}, questions: settings.questionnaire || [], dossier: settings.dossier || null, done: !!profile.done },
    shot: hasShotRound && team ? (shot || {}) : null, missions };
}
