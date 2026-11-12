// Spelvormen: Ranking de Boys, Shot in het duister, Dragons, Ken je kompaan, Buitentas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { Live } from '../server/live.js';
import * as C from '../server/content.js';
import * as M from '../server/modules.js';
import { playerView, displayView, staffView } from '../server/views.js';
import { createGrant, staffByToken } from '../server/auth.js';
import { importPack, emergencyPack } from '../server/exporting.js';

function setup() {
  const db = openDb(':memory:');
  let t = Date.now() + 60_000;
  const clock = { now: () => t, add: ms => { t += ms; } };
  const live = new Live({ db, clock: clock.now, schedule: false });
  const { event } = C.createEvent(db, { name: 'Mod', settings: { countdownMs: 0 } });
  const E = event.id;
  const T = {}; const P = {};
  [['A', ['a1', 'a2']], ['B', ['b1', 'b2']], ['C', ['c1', 'c2']], ['D', ['d1', 'd2']], ['E', ['e1', 'e2', 'e3']]].forEach(([tn, ns]) => {
    T[tn] = C.upsertTeam(db, E, { name: tn });
    ns.forEach(n => { const r = C.joinEvent(db, { code: event.join_code, name: n, teamId: T[tn] }); P[n] = db.get('SELECT * FROM participants WHERE id = ?', r.participantId); });
  });
  const ev = () => db.get('SELECT * FROM events WHERE id = ?', E);
  const run = (action, extra = {}) => live.action(E, 'test', { action, seq: live.state(E).seq, ...extra });
  const play = (qid, answers) => { run('prepare', { questionId: qid }); run('open'); clock.add(10); for (const [p, a] of answers) live.submit(E, P[p], { questionId: qid, answer: a }); run('close'); };
  const pts = () => Object.fromEntries(live.scoreboard(E).teams.map(t => [t.name, t.points]));
  return { db, live, clock, E, T, P, ev, run, play, pts };
}

test('Ranking de Boys: zelfstemmen uit, gedeelde winnaars, alleen totalen, 0 stemmen = vervalt', () => {
  const { db, live, E, P, run, play, pts, ev } = setup();
  const r = C.upsertRound(db, E, { title: 'Ranking', kind: 'ranking' });
  const q = C.upsertQuestion(db, E, { roundId: r, type: 'ranking', prompt: 'Wie heeft de beste versiertrucs?', seconds: 20, points: 2 });
  const q0 = C.upsertQuestion(db, E, { roundId: r, type: 'ranking', prompt: 'Niemand stemt hierop', seconds: 20, points: 2 });
  assert.throws(() => M.castVote(db, E, P.a1, { questionId: q, choiceId: P.a1.id }), /jezelf/);
  // b1 en c1 krijgen ieder 2 stemmen (gedeelde eerste plaats); a2 slaat over
  M.castVote(db, E, P.a1, { questionId: q, choiceId: P.b1.id });
  M.castVote(db, E, P.a2, { questionId: q, choiceId: null });
  M.castVote(db, E, P.d1, { questionId: q, choiceId: P.b1.id });
  M.castVote(db, E, P.e1, { questionId: q, choiceId: P.c1.id });
  M.castVote(db, E, P.e2, { questionId: q, choiceId: P.d2.id });
  M.castVote(db, E, P.e2, { questionId: q, choiceId: P.c1.id }); // stem wijzigen mag vóór de vraag
  // teams voorspellen (captains)
  play(q, [['a1', P.b1.id], ['b1', P.c1.id], ['c1', P.d2.id]]);
  assert.throws(() => M.castVote(db, E, P.b2, { questionId: q, choiceId: P.b1.id }), /gesloten/);
  run('reveal');
  const res = displayView(live, ev(), new Set(), 'x').result.ranking;
  assert.deepEqual(res.top.map(x => [x.name, x.votes, x.winner]), [['b1', 2, true], ['c1', 2, true]]);
  assert.ok(res.top.every(x => Object.keys(x).sort().join() === 'name,votes,winner'), 'alleen totalen, geen kiezers');
  assert.ok(!JSON.stringify(displayView(live, ev(), new Set(), 'x')).includes('voter'), 'geen kiezers in de payload');
  run('score');
  assert.deepEqual(pts(), { A: 2, B: 2, C: 0, D: 0, E: 0 });
  play(q0, [['a1', P.b1.id]]); run('reveal'); run('score');
  assert.equal(pts().A, 2, 'zonder geldige stemmen geen punten');
  assert.equal(JSON.parse(JSON.stringify(displayView(live, ev(), new Set(), 'x'))).result.ranking.skipped, true);
});

test('Shot in het duister: geen punten/inzending op eigen shot, onthulling pas na alle shots, 1+1+1', () => {
  const { db, live, E, T, P, run, play, pts, ev } = setup();
  const r = C.upsertRound(db, E, { title: 'Shots', kind: 'shots' });
  const shots = {};
  [['A', 'Drop', 'Wodka', 1], ['B', 'Koffie', 'Rum', 2]].forEach(([tn, f, b, n]) => {
    M.saveShot(db, E, T[tn], { name: tn + ' shot', flavor: f, base: b, allergens: 'geen', story: 'Verhaal ' + tn }, 'x');
    shots[tn] = db.get('SELECT id FROM shots WHERE team_id = ?', T[tn]).id;
    M.adminShot(db, E, shots[tn], { number: n, acceptedFlavors: f === 'Drop' ? 'zoethout\nsalmiak' : '', acceptedBases: '' });
  });
  assert.throws(() => M.adminShot(db, E, shots.B, { number: 1 }), /al vergeven/);
  const q1 = C.upsertQuestion(db, E, { roundId: r, type: 'shot', prompt: 'Shot 1', seconds: 30, settings: { shotNumber: 1 } });
  const q2 = C.upsertQuestion(db, E, { roundId: r, type: 'shot', prompt: 'Shot 2', seconds: 30, settings: { shotNumber: 2 } });
  // Shot 1 is van team A: A mag niet inzenden; B raadt alles goed (variant "salmiak"), C alleen team
  run('prepare', { questionId: q1 }); run('open');
  assert.throws(() => live.submit(E, P.a1, { questionId: q1, answer: { flavor: 'drop', base: 'wodka', teamId: T.B } }), /eigen shot/);
  assert.throws(() => live.submit(E, P.b1, { questionId: q1, answer: { flavor: 'x', base: 'y', teamId: T.B } }), /ander team/);
  live.submit(E, P.b1, { questionId: q1, answer: { flavor: 'Salmiak', base: 'wodka', teamId: T.A } });
  live.submit(E, P.c1, { questionId: q1, answer: { flavor: 'kers', base: 'gin', teamId: T.A } });
  run('close');
  assert.throws(() => run('reveal'), /samen onthuld/);
  assert.throws(() => run('shots_reveal', { roundId: r }), /Nog niet alle shots/);
  const pv = JSON.stringify(playerView(live, { participant: P.c1, event: ev() }, new Set()));
  assert.ok(!pv.includes('Verhaal A') && !pv.includes('A shot'), 'geen herkomst of verhaal vóór de onthulling');
  // Onafhankelijk raden: C noemt team A opnieuw bij shot 2 (mag), A raadt B
  play(q2, [['c1', { flavor: 'koffie', base: 'rum', teamId: T.A }], ['a1', { flavor: 'koffie', base: 'rum', teamId: T.B }]]);
  run('shots_reveal', { roundId: r });
  assert.deepEqual(pts(), { A: 3, B: 3, C: 1 + 2, D: 0, E: 0 });
  const dv = displayView(live, ev(), new Set(), 'x');
  assert.equal(dv.shotsReveal.shots.length, 2);
  assert.equal(dv.shotsReveal.shots[0].team, 'A');
});

test('Dragons: niet in eigen team, precies €10.000 in stappen van €500, geheim tot onthulling, 5-4-3-2-1 met gelijke stand', () => {
  const { db, live, E, T, P, run, pts, ev, clock } = setup();
  const r = C.upsertRound(db, E, { title: 'Dragons', kind: 'dragons' });
  const q = C.upsertQuestion(db, E, { roundId: r, type: 'invest', prompt: 'Verdeel je €10.000', seconds: 60 });
  run('prepare', { questionId: q }); run('open'); clock.add(10);
  assert.throws(() => live.submit(E, P.a1, { questionId: q, answer: { [T.A]: 5000, [T.B]: 5000 } }), /eigen team/);
  assert.throws(() => live.submit(E, P.a1, { questionId: q, answer: { [T.B]: 9000 } }), /precies/);
  assert.throws(() => live.submit(E, P.a1, { questionId: q, answer: { [T.B]: 9750, [T.C]: 250 } }), /stappen/);
  assert.throws(() => live.submit(E, P.a1, { questionId: q, answer: { [T.B]: 12000, [T.C]: -2000 } }), /stappen|precies/);
  live.submit(E, P.a1, { questionId: q, answer: { [T.B]: 6000, [T.C]: 4000 } });
  live.submit(E, P.b1, { questionId: q, answer: { [T.C]: 6000, [T.A]: 4000 } });
  live.submit(E, P.c1, { questionId: q, answer: { [T.D]: 10000 } });
  live.submit(E, P.d1, { questionId: q, answer: { [T.E]: 4000, [T.A]: 6000 } });
  live.submit(E, P.e1, { questionId: q, answer: { [T.B]: 4000, [T.D]: 6000 } });
  // A 10000, B 10000, C 10000, D 16000, E 4000
  assert.ok(!JSON.stringify(displayView(live, ev(), new Set(), 'x')).includes('16000'), 'investeringen geheim tot onthulling');
  run('close'); run('reveal');
  assert.ok(JSON.stringify(displayView(live, ev(), new Set(), 'x')).includes('16000'));
  run('score');
  assert.deepEqual(pts(), { D: 5, A: 4, B: 4, C: 4, E: 1 });
});

test('Ken je kompaan: duo vergelijkt, trio roteert zichtbaar, niet-aangewezen speler geblokkeerd', () => {
  const { db, live, E, T, P, run, pts, clock } = setup();
  const r = C.upsertRound(db, E, { title: 'Kompaan', kind: 'kompaan' });
  const mk = n => C.upsertQuestion(db, E, { roundId: r, type: 'mc', scope: 'individual', prompt: 'Wat bestelt je kompaan? ' + n, options: ['Bier', 'Wijn', 'Fris'], seconds: 30, points: 1, settings: { kompaan: true } });
  const q1 = mk(1), q2 = mk(2), q3 = mk(3);
  const pairs = [q1, q2, q3].map(q => M.kompaanPair(db, { ...live.question(q), event_id: E }, T.E).map(p => p.id));
  const skipped = pairs.map(pr => ['e1', 'e2', 'e3'].find(n => !pr.includes(P[n].id)));
  assert.deepEqual(skipped, ['e1', 'e2', 'e3'], 'elk triolid zit één keer over');
  run('prepare', { questionId: q1 }); run('open'); clock.add(10);
  assert.throws(() => live.submit(E, P.e1, { questionId: q1, answer: 0 }), /teamgenoten/);
  live.submit(E, P.e2, { questionId: q1, answer: 1 }); live.submit(E, P.e3, { questionId: q1, answer: 1 });
  live.submit(E, P.a1, { questionId: q1, answer: 0 }); live.submit(E, P.a2, { questionId: q1, answer: 2 });
  live.submit(E, P.b1, { questionId: q1, answer: 2 }); live.submit(E, P.b2, { questionId: q1, answer: 2 });
  run('close'); run('reveal'); run('score');
  assert.deepEqual(pts(), { B: 1, E: 1, A: 0, C: 0, D: 0 });
});

test('Buitentas: kassabon dichtst bij 12:00 en 250 gram, gelijke afwijking deelt punten, niet ingeleverd 0', () => {
  const { db, live, E, T, pts } = setup();
  const bon = M.upsertMission(db, E, { title: 'Kassabon', kind: 'closest', target: '12:00', unit: 'min' });
  const gram = M.upsertMission(db, E, { title: '250 gram', kind: 'closest', target: '250', unit: 'g' });
  const tas = M.upsertMission(db, E, { title: 'Mysterieus voorwerp', kind: 'check', maxPoints: 2 });
  M.saveEvidence(db, E, T.A, bon, { value: '12:00' }, 'x');
  M.checkEvidence(db, E, bon, T.A, { measured: '12:00', checked: true });
  M.checkEvidence(db, E, bon, T.B, { measured: '11:58', checked: true });
  M.checkEvidence(db, E, bon, T.C, { measured: '12:02', checked: true });
  M.checkEvidence(db, E, bon, T.D, { measured: '13:30', checked: true });
  // E levert niets in
  live.scoreMission(E, 't', bon);
  assert.deepEqual(pts(), { A: 5, B: 4, C: 4, D: 2, E: 0 });
  live.scoreMission(E, 't', bon); // opnieuw scoren: geen dubbeling
  assert.equal(pts().A, 5);
  M.checkEvidence(db, E, gram, T.E, { measured: '249,5', checked: true });
  M.checkEvidence(db, E, gram, T.A, { measured: '300', checked: false }); // afgekeurd
  live.scoreMission(E, 't', gram);
  assert.equal(pts().E, 5); assert.equal(pts().A, 5);
  M.checkEvidence(db, E, tas, T.C, { checked: true });
  live.scoreMission(E, 't', tas);
  assert.equal(pts().C, 6);
  assert.throws(() => M.saveEvidence(db, E, T.B, bon, { value: '12:00' }, 'x'), /al beoordeeld/);
});

test('captain: wie zich aanmeldt neemt het over van een vooraf ingevoerde captain die nooit is aangemeld', () => {
  const db = openDb(':memory:');
  const { event } = C.createEvent(db, { name: 'Cap' });
  const tid = C.upsertTeam(db, event.id, { name: 'Lobbers' });
  C.upsertParticipant(db, event.id, { name: 'Bas', teamId: tid });
  C.upsertParticipant(db, event.id, { name: 'Joris', teamId: tid });
  const capName = () => db.get('SELECT p.name FROM memberships m JOIN participants p ON p.id = m.participant_id WHERE m.team_id = ? AND m.is_captain = 1', tid).name;
  assert.equal(capName(), 'Bas');
  C.joinEvent(db, { code: event.join_code, name: 'Reno', teamId: tid });
  assert.equal(capName(), 'Reno');
  C.joinEvent(db, { code: event.join_code, name: 'Joris' });
  assert.equal(capName(), 'Reno', 'een aangemelde captain blijft captain');
});

test('vorige vraag: terugkijken toont de uitslag zonder opnieuw te openen of dubbel te scoren', () => {
  const { db, live, E, P, run, pts } = setup();
  const r = C.upsertRound(db, E, { kind: 'quiz', title: 'Q' });
  const q1 = C.upsertQuestion(db, E, { roundId: r, type: 'mc', prompt: 'een', options: ['a', 'b'], seconds: 30, points: 1, key: { correct: 0 } });
  const q2 = C.upsertQuestion(db, E, { roundId: r, type: 'mc', prompt: 'twee', options: ['a', 'b'], seconds: 30, points: 1, key: { correct: 0 } });
  run('prepare', { questionId: q1 }); run('open'); live.submit(E, P.a1, { questionId: q1, answer: 0 }); run('close'); run('reveal'); run('score');
  run('prepare', { questionId: q2 });
  assert.equal(live.prevQuestionId(E), q1);
  run('goto', { questionId: q1 });
  assert.equal(live.state(E).question_id, q1);
  assert.equal(live.state(E).phase, 'scored');
  assert.throws(() => run('open'));
  assert.equal(pts().A, 1);
  assert.equal(live.nextQuestionId(E), q2);
  run('goto', { questionId: q2 });
  assert.equal(live.state(E).phase, 'ready');
});

test('teamadvies: teamgenoot tikt advies, captain beslist; na 3x fout gaat de captainrol naar de beste adviseur', () => {
  const { db, live, E, T, P, run } = setup();
  const r = C.upsertRound(db, E, { kind: 'quiz', title: 'Q' });
  const cap = () => db.get('SELECT participant_id FROM memberships WHERE team_id = ? AND is_captain = 1', T.A).participant_id;
  assert.equal(cap(), P.a1.id);
  // a2 is geen captain: inzenden mag niet, advies wel
  const qs = [0, 1, 2, 3].map(i => C.upsertQuestion(db, E, { roundId: r, type: 'mc', prompt: 'v' + i, options: ['goed', 'fout'], seconds: 30, points: 1, key: { correct: 0 } }));
  for (const [i, qid] of qs.slice(0, 3).entries()) {
    run('prepare', { questionId: qid }); run('open');
    assert.throws(() => live.submit(E, P.a2, { questionId: qid, answer: 0 }));
    live.advise(E, P.a2, { questionId: qid, answer: 0 });
    live.advise(E, P.a2, { questionId: qid, answer: 0 }); // overschrijven mag
    assert.throws(() => live.advise(E, P.a1, { questionId: qid, answer: 0 }), /captain/);
    const view = playerView(live, { participant: P.a1, event: db.get('SELECT * FROM events WHERE id = ?', E) }, new Set());
    assert.equal(view.advice.length, 1); assert.equal(view.advice[0].name, 'a2');
    live.submit(E, P.a1, { questionId: qid, answer: 1 });
    assert.throws(() => live.advise(E, P.a2, { questionId: qid, answer: 1 }));
    run('close'); run('reveal'); run('score');
    if (i < 2) assert.equal(cap(), P.a1.id, 'nog geen wissel na ' + (i + 1) + 'x fout');
  }
  assert.equal(cap(), P.a2.id, 'na 3x fout wordt a2 captain');
  const b = live.state(E).banner; assert.ok(b && JSON.parse(b).changes[0].to === 'a2');
  run('prepare', { questionId: qs[3] });
  assert.equal(live.state(E).banner, null, 'melding verdwijnt bij de volgende vraag');
});

test('teamadvies: wissel staat uit als de avond dat zegt', () => {
  const { db, live, E, T, P, run } = setup();
  C.updateEvent(db, E, { settings: { autoCaptain: false } });
  const r = C.upsertRound(db, E, { kind: 'quiz', title: 'Q' });
  for (let i = 0; i < 3; i++) {
    const qid = C.upsertQuestion(db, E, { roundId: r, type: 'tf', prompt: 'v' + i, seconds: 30, points: 1, key: { correct: 0 } });
    run('prepare', { questionId: qid }); run('open'); live.submit(E, P.a1, { questionId: qid, answer: 1 }); run('close'); run('reveal'); run('score');
  }
  assert.equal(db.get('SELECT participant_id FROM memberships WHERE team_id = ? AND is_captain = 1', T.A).participant_id, P.a1.id);
});

test('ranking top 3: 2 pt per goede plek, 1 pt als de naam wel in de top 3 staat, gedeelde plekken tellen mee', () => {
  const { db, live, E, P, run, pts } = setup();
  const r = C.upsertRound(db, E, { kind: 'ranking', title: 'R' });
  const q = C.upsertQuestion(db, E, { roundId: r, type: 'ranking', prompt: 'wie?', seconds: 30, settings: { top: 3 } });
  // stemmen: b1 4x, c1 3x, d1 2x, e1 2x (gedeeld 3e)
  const vote = (voters, who) => voters.forEach(v => M.castVote(db, E, P[v], { questionId: q, choiceId: P[who].id }));
  vote(['a1', 'a2', 'c1', 'd1'], 'b1'); vote(['a1x', 'b1', 'b2'].filter(x => P[x]), 'c1'); M.castVote(db, E, P.e1, { questionId: q, choiceId: P.c1.id });
  vote(['e2', 'e3'], 'd1'); vote(['c2', 'd2'], 'e1');
  const ranked = M.rankingTop(db, q).ranked;
  assert.deepEqual(ranked.slice(0, 4).map(x => [x.name, x.rank]), [['b1', 1], ['c1', 2], ['d1', 3], ['e1', 3]]);
  run('prepare', { questionId: q }); run('open');
  assert.throws(() => live.submit(E, P.a1, { questionId: q, answer: [P.b1.id] }), /3/);
  live.submit(E, P.a1, { questionId: q, answer: [P.b1.id, P.c1.id, P.e1.id] });   // A: 2+2+2 = 6
  live.submit(E, P.b1, { questionId: q, answer: [P.c1.id, P.b1.id, P.a1.id] });   // B: 1+1+0 = 2
  live.submit(E, P.c1, { questionId: q, answer: [P.a1.id, P.a2.id, P.b2.id] });   // C: 0
  run('close'); run('reveal'); run('score');
  const p = pts(); assert.equal(p.A, 6); assert.equal(p.B, 2); assert.equal(p.C, 0);
});

test('vragenlijst vooraf: id\'s blijven stabiel en het overzicht toont antwoorden per vraag', () => {
  const { db, E } = setup();
  C.updateEvent(db, E, { settings: { questionnaire: [{ q: 'Eerste concert?' }, { q: '' }, { q: 'Domste aankoop?' }] } });
  const qs = JSON.parse(db.get('SELECT settings FROM events WHERE id = ?', E).settings).questionnaire;
  assert.equal(qs.length, 2); assert.ok(qs[0].id);
  C.updateEvent(db, E, { settings: { questionnaire: [{ id: qs[1].id, q: 'Domste aankoop?' }, { id: qs[0].id, q: 'Eerste concert?' }] } });
  const qs2 = JSON.parse(db.get('SELECT settings FROM events WHERE id = ?', E).settings).questionnaire;
  assert.deepEqual(qs2.map(x => x.id), [qs[1].id, qs[0].id]);
  C.updateEvent(db, E, { name: 'Andere naam', settings: { drinks: false } });
  assert.equal(JSON.parse(db.get('SELECT settings FROM events WHERE id = ?', E).settings).questionnaire.length, 2, 'andere instellingen opslaan wist de vragenlijst niet');
});

test('berichten: Nederlandse tijd, inplannen, één keer bezorgen, alleen verstuurde zichtbaar', async () => {
  const MSG = await import('../server/messages.js');
  const { db, E } = setup();
  assert.equal(MSG.epochToLocal(MSG.localToEpoch('2026-11-20T17:00')), '2026-11-20T17:00');
  assert.equal(new Date(MSG.localToEpoch('2026-11-20T17:00')).toISOString(), '2026-11-20T16:00:00.000Z'); // wintertijd
  assert.equal(new Date(MSG.localToEpoch('2026-07-01T17:00')).toISOString(), '2026-07-01T15:00:00.000Z'); // zomertijd
  assert.throws(() => MSG.upsertMessage(db, E, { title: '' }), /titel/);
  const n = MSG.importMessages(db, E, [{ sendAt: '2020-01-01T10:00', title: 'Oud', link: 'vragenlijst' }, { sendAt: '2099-01-01T10:00', title: 'Later', link: 'hack' }]);
  assert.equal(n, 2);
  assert.equal(MSG.playerMessages(db, E).length, 0);
  assert.deepEqual(await MSG.deliverDue(db, Date.now(), { push: false }), [E]);
  assert.deepEqual(await MSG.deliverDue(db, Date.now(), { push: false }), []); // nooit dubbel
  const pm = MSG.playerMessages(db, E);
  assert.equal(pm.length, 1); assert.equal(pm[0].title, 'Oud'); assert.equal(pm[0].link, 'vragenlijst');
  const st = MSG.staffMessages(db, E).list;
  assert.equal(st.find(m => m.title === 'Later').link, null);
  assert.throws(() => MSG.upsertMessage(db, E, { id: pm[0].id, title: 'x' }), /al verstuurd/);
  MSG.sendNow(db, E, st.find(m => m.title === 'Later').id);
  await MSG.deliverDue(db, Date.now() + 1, { push: false });
  assert.equal(MSG.playerMessages(db, E).length, 2);
});

test('shot-roulette: alleen aangemelde spelers, uitsluiten werkt, nooit twee keer achter elkaar dezelfde', () => {
  const { db, live, E, P } = setup();
  const r1 = live.roulette(E, 'test', { task: 'Neem 3 slokken!', exclude: [P.a1.id] });
  assert.equal(r1.task, 'Neem 3 slokken!');
  assert.notEqual(r1.winner.id, P.a1.id);
  assert.ok(r1.names.length === 10 && !r1.names.includes('a1'));
  let prev = r1.winner.id;
  for (let i = 0; i < 30; i++) { const r = live.roulette(E, 'test', {}); assert.notEqual(r.winner.id, prev); assert.notEqual(r.winner.id, P.a1.id); prev = r.winner.id; }
  assert.deepEqual(JSON.parse(db.get('SELECT settings FROM events WHERE id = ?', E).settings).rouletteExclude, [P.a1.id]);
  const all = Object.values(P).map(p => p.id);
  assert.throws(() => live.roulette(E, 'test', { exclude: all }), /niemand/);
  const one = all.filter(x => x !== P.b1.id);
  assert.equal(live.roulette(E, 'test', { exclude: one }).winner.id, P.b1.id);
  assert.equal(live.roulette(E, 'test', { exclude: one }).winner.id, P.b1.id); // enige kandidaat mag wel opnieuw
  live.rouletteClose(E, 'test');
  assert.equal(live.state(E).roulette, null);
});

test('quizmaster doet mee: roulette (0.0-variant), Dragons-investering, zonder team in individuele ranglijst, verzegelde ronde', () => {
  const { db, live, E, T, P, run, pts, ev, clock } = setup();
  // Roulette: alleen de quizmaster over → hij wint, met de 0.0-variant
  const all = Object.values(P).map(p => p.id);
  const r = live.roulette(E, 'test', { task: 'Neem een shotje!', exclude: all, host: { on: true, name: 'Rinus' } });
  assert.equal(r.winner.id, 'host'); assert.equal(r.winner.name, 'Rinus'); assert.match(r.task, /0\.0/);
  // Rinus meldt zich aan als speler zonder team: telt één keer mee in de roulette
  const rin = C.joinEvent(db, { code: ev().join_code, name: 'Rinus' });
  const r2 = live.roulette(E, 'test', { exclude: [], host: { on: true, name: 'Rinus' } });
  assert.equal(r2.names.filter(n => n === 'Rinus').length, 1);
  live.roulette(E, 'test', { exclude: [], host: { on: false, name: 'Rinus' } });
  for (let i = 0; i < 20; i++) assert.notEqual(live.roulette(E, 'test', {}).winner.name, 'Rinus');

  // Dragons: quizmaster investeert €10.000 en telt mee in de totalen
  const dr = C.upsertRound(db, E, { title: 'Dragons', kind: 'dragons' });
  const q = C.upsertQuestion(db, E, { roundId: dr, type: 'invest', prompt: 'Verdeel', seconds: 60 });
  assert.throws(() => live.hostInvest(E, 'test', { [T.A]: 10000 }), /Dragons/);
  run('prepare', { questionId: q }); run('open'); clock.add(10);
  assert.throws(() => live.hostInvest(E, 'test', { [T.A]: 9000 }), /precies/);
  live.hostInvest(E, 'test', { [T.A]: 5000, [T.B]: 5000 });
  live.hostInvest(E, 'test', { [T.E]: 10000 }); // aanpassen mag
  live.submit(E, P.a1, { questionId: q, answer: { [T.B]: 10000 } });
  const sv = staffView(live, { event: ev(), role: 'owner', grant: { label: 'Eigenaar' } }, new Set(), 'x');
  assert.equal(sv.counts.submitted, 1);
  assert.equal(sv.submissions.find(x => x.owner === 'host').by, 'Quizmaster');
  run('close'); run('reveal');
  assert.throws(() => live.hostInvest(E, 'test', { [T.A]: 10000 }), /onthuld/);
  run('score');
  assert.equal(pts().E, 5); assert.equal(pts().B, 5); // gelijk: allebei €10.000

  // Verzegelde bliksemronde: eigenaar ziet geen vragen/antwoorden, live starten werkt, Rinus speelt individueel mee
  importPack(db, E, { format: 'bamigo-pack@1', rounds: [{ kind: 'lightning', title: 'Versla Rinus', settings: { sealed: true },
    questions: [{ type: 'mc', scope: 'individual', scoring: 'speed', prompt: 'GEHEIME-VRAAG', options: ['x', 'GEHEIM-JUIST'], seconds: 15, points: 3, key: { correct: 1 } }] }] });
  const owner = () => staffView(live, { event: ev(), role: 'owner', grant: { label: 'Eigenaar' } }, new Set(), 'x');
  assert.ok(!JSON.stringify(owner()).includes('GEHEIM'));
  assert.ok(!emergencyPack(db, E).includes('GEHEIM'));
  const sq = owner().rounds.find(x => x.title === 'Versla Rinus');
  assert.ok(sq.sealed && sq.questions[0].sealed);
  run('prepare', { questionId: sq.questions[0].id });
  assert.ok(!JSON.stringify(owner()).includes('GEHEIM'), 'ook niet als hij klaarstaat');
  run('open'); clock.add(10);
  const rinus = db.get('SELECT * FROM participants WHERE id = ?', rin.participantId);
  live.submit(E, rinus, { questionId: sq.questions[0].id, answer: 1 });
  run('close');
  assert.ok(!JSON.stringify(owner().currentKey || {}).includes('1') || owner().currentKey == null, 'sleutel pas na onthullen');
  run('reveal'); run('score');
  const ind = live.scoreboard(E).individuals;
  assert.equal(ind[0].name, 'Rinus'); assert.ok(ind[0].points > 0);
});

test('De BAMIGO Envelop: verzegeld (ook voor host), stand vastzetten, +2 bij exact, quizmaster-envelop, nooit dubbel', () => {
  const { db, live, E, T, P, run, pts, ev, clock } = setup();
  const r = C.upsertRound(db, E, { title: 'Intro', kind: 'intro' });
  const q = C.upsertQuestion(db, E, { roundId: r, type: 'envelope', scope: 'team', prompt: 'Op welke plek eindigen jullie?', seconds: 60 });
  assert.throws(() => C.upsertQuestion(db, E, { roundId: r, type: 'envelope', scope: 'individual', prompt: 'x' }), /teamvraag/);
  assert.throws(() => live.action(E, 'test', { action: 'envelopes_open' }), /leeg/);
  run('prepare', { questionId: q }); run('open'); clock.add(10);
  const pv = playerView(live, { participant: P.a1, event: ev() }, new Set());
  assert.equal(pv.question.options.length, 5);
  assert.throws(() => live.submit(E, P.a1, { questionId: q, answer: 5 }), /plek/);
  live.submit(E, P.a1, { questionId: q, answer: 0 });   // A voorspelt 1e
  live.submit(E, P.b1, { questionId: q, answer: 1 });   // B voorspelt 2e
  live.submit(E, P.c1, { questionId: q, answer: 0 });   // C voorspelt 1e
  live.hostEnvelope(E, 'test', [T.B, T.A, T.C, T.D, T.E]);
  run('close');
  const owner = () => staffView(live, { event: ev(), role: 'owner', grant: { label: 'Eigenaar' } }, new Set(), 'x');
  assert.ok(owner().submissions.every(x => x.answer === undefined), 'verzegeld, ook voor de eigenaar');
  assert.throws(() => run('reveal'), /enveloppen/);
  // stand: A 10, B 6, C 6, D 1, E 0
  const add = (team, n) => db.run("INSERT INTO score_events (id, event_id, team_id, board, points, reason, kind, created_at) VALUES (?,?,?,'team',?,'test','manual',?)", 'e' + Math.random(), E, team, n, Date.now());
  add(T.A, 10); add(T.B, 6); add(T.C, 6); add(T.D, 1);
  run('envelopes_open');
  const env = live.state(E).screen;
  assert.equal(env, 'envelopes');
  const data = displayView(live, ev(), new Set(), 'x').live.envelopes;
  assert.equal(data.list.at(-1).name, 'A'); assert.ok(data.list.at(-1).hit);
  assert.ok(data.list.find(x => x.name === 'B').hit, 'gedeelde 2e plek telt');
  assert.ok(!data.list.find(x => x.name === 'C').hit);
  assert.equal(data.list.find(x => x.name === 'D').predicted, null);
  assert.equal(data.host.hits, 2); // D 4e en E 5e goed
  assert.deepEqual(pts(), { A: 12, B: 8, C: 6, D: 1, E: 0 });
  run('envelopes_open'); // opnieuw tonen: geen dubbele bonus
  assert.deepEqual(pts(), { A: 12, B: 8, C: 6, D: 1, E: 0 });
  assert.throws(() => live.hostEnvelope(E, 'test', [T.A, T.B, T.C, T.D, T.E]), /envelop-vraag|al open/);
});
