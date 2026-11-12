// Rolgefilterde views. Hier wordt bepaald wat elke client mag zien.
// Regel: antwoordsleutels, verborgen inzendingen en geheime stemmen gaan nooit naar een client
// die ze (nog) niet mag zien — ook niet "verstopt" in de payload.
import { json } from './db.js';
import { can } from './auth.js';
import * as M from './modules.js';

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
    options: visible ? q.options : null,
    right: visible && q.type === 'match' ? (q.settings.right || []) : null,
    kompaan: !!q.settings.kompaan,
    candidates: visible && q.type === 'ranking' ? live.db.all('SELECT id, name FROM participants WHERE event_id = ? ORDER BY name', q.event_id) : null,
    teams: visible && ['shot', 'invest'].includes(q.type) ? live.db.all('SELECT id, name FROM teams WHERE event_id = ? ORDER BY sort, name', q.event_id) : null,
    budget: q.type === 'invest' ? (q.settings.budget || M.DRAGONS_BUDGET) : null, step: q.type === 'invest' ? M.DRAGONS_STEP : null,
    shotNumber: q.type === 'shot' ? q.settings.shotNumber : null,
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

function liveInfo(live, s, t) {
  return { screen: s.screen, phase: s.phase, paused: !!s.paused, seq: s.seq, openAt: s.open_at, deadline: s.deadline,
    pausedAt: s.paused_at, message: s.message, round: roundInfo(live.db, s.round_id) };
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
  const submitted = live.db.get('SELECT COUNT(*) AS n FROM submissions WHERE question_id = ?', s.question_id).n;
  const expected = q.scope === 'team'
    ? live.db.get('SELECT COUNT(*) AS n FROM teams WHERE event_id = ?', eventId).n
    : live.db.get('SELECT COUNT(*) AS n FROM participants WHERE event_id = ? AND joined_at IS NOT NULL', eventId).n;
  return { submitted, expected };
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
  let mine = null, result = null;
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
  }
  const showBoard = ['scoreboard', 'finale'].includes(s.screen);
  return {
    kind: 'player', serverNow: t, event: eventInfo(event),
    me: { id: participant.id, name: participant.name, teamId: team?.id ?? null, teamName: team?.name ?? null, isCaptain: !!m?.is_captain, joinedAt: participant.joined_at },
    team: team ? { ...team, members: db.all(`SELECT p.id, p.name, m.is_captain FROM memberships m JOIN participants p ON p.id = m.participant_id WHERE m.team_id = ? ORDER BY p.name`, team.id)
      .map(x => ({ id: x.id, name: x.name, isCaptain: !!x.is_captain, online: online.has(x.id) })) } : null,
    live: liveInfo(live, s, t), question: q, mine, result,
    scoreboard: showBoard ? boardFor(live, event.id, { topTeams: 100, topPeople: 5, meId: participant.id }) : null,
    shotsReveal: s.screen === 'shots_reveal' ? M.shotsRevealData(db, event.id, s.round_id) : null,
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
    if (full || host) {
      r.questions = list.map(q => {
        const base = { id: q.id, type: q.type, scope: q.scope, scoring: q.scoring, seconds: q.seconds, points: q.points, sort: q.sort, voided: !!q.voided_at, played: played.has(q.id), isExample: !!q.is_example };
        if (!full && !can(role, 'live.prompts')) return base;
        Object.assign(base, { prompt: q.prompt, quote: q.quote, context: q.context, options: json(q.options, []), allowBet: !!q.allow_bet, mediaId: q.media_id, settings: json(q.settings, {}) });
        if (full) { const k = keys.get(q.id); base.key = k ? { correct: json(k.correct), accepted: json(k.accepted, []), explanation: k.explanation, tolerance: k.tolerance } : null; }
        return base;
      });
    }
  }
  const view = {
    kind: 'staff', role, roleLabel: grant.label, serverNow: t, event: { ...eventInfo(event), joinCode: event.join_code, joinUrl, settings: json(event.settings, {}) },
    perms: { content: can(role, 'content.write'), answers: full, live: host, scores: can(role, 'scores.write'), people: can(role, 'people.write'), roles: can(role, 'roles.manage') },
    teams: teams.map(tm => ({ ...tm, members: tm.members })), unassigned,
    rounds, live: liveInfo(live, s, t), counts: counts(live, event.id, s),
    plannedMinutes: rounds.reduce((a, r) => a + (r.minutes || 0), 0),
    readiness: readiness(db, event.id, full),
    nextQuestionId: host ? live.nextQuestionId(event.id) : null,
    prevQuestionId: host ? live.prevQuestionId(event.id) : null,
    scoreboard: boardFor(live, event.id, { topTeams: 100, topPeople: 100 }),
  };
  if (host || full) {
    view.question = publicQuestion(live, s, t);
    // Host ziet de sleutel van de actieve vraag pas na sluiten; inhoudsbeheer altijd.
    if (s.question_id && (full || (host && AFTER_CLOSE.includes(s.phase)))) {
      const k = live.answerKey(s.question_id);
      view.currentKey = { correct: k.correct, accepted: k.accepted, explanation: k.explanation, tolerance: k.tolerance };
    }
    if (s.question_id) {
      const subs = db.all(`SELECT s.*, p.name AS by_name, tm.name AS team_name FROM submissions s LEFT JOIN participants p ON p.id = s.participant_id
        LEFT JOIN teams tm ON tm.id = s.team_id WHERE s.question_id = ? ORDER BY s.received_at`, s.question_id);
      const showAnswers = full || AFTER_CLOSE.includes(s.phase);
      view.submissions = subs.map(x => ({ id: x.id, owner: x.owner_key, by: x.by_name, team: x.team_name, elapsedMs: x.elapsed_ms, bet: x.bet,
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
      WHERE q.event_id = ? AND q.type NOT IN ('ranking', 'shot', 'invest') AND COALESCE(json_extract(q.settings, '$.kompaan'), 0) <> 1 AND (k.correct IS NULL OR k.correct = 'null')`, eventId),
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
  return { ranking, candidates: people.filter(p => settings.selfVote || p.id !== participant.id), profile: { story: profile.story || '', limits: profile.limits || '', done: !!profile.done },
    shot: hasShotRound && team ? (shot || {}) : null, missions };
}
