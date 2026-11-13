// Spelmotor: state-machine, inzendingen, scoring, geheimhouding. Met een bestuurbare klok.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { Live } from '../server/live.js';
import * as C from '../server/content.js';
import { playerView, displayView, staffView } from '../server/views.js';
import { speedScore, judgeOpen, competitionRanks, normalize } from '../server/scoring.js';
import { staffByToken, createGrant } from '../server/auth.js';

function setup() {
  const db = openDb(':memory:');
  let t = Date.now() + 60_000;
  const clock = { now: () => t, add: ms => { t += ms; } };
  const live = new Live({ db, clock: clock.now, schedule: false });
  const { event, ownerToken } = C.createEvent(db, { name: 'Test', settings: { countdownMs: 3000 } });
  const E = event.id;
  const teams = ['A', 'B', 'C', 'D', 'E'].map(n => C.upsertTeam(db, E, { name: n }));
  const people = {};
  const names = [['a1', 'a2'], ['b1', 'b2'], ['c1', 'c2'], ['d1', 'd2'], ['e1', 'e2', 'e3']];
  names.forEach((ns, i) => ns.forEach(n => { const r = C.joinEvent(db, { code: event.join_code, name: n, teamId: teams[i] }); people[n] = db.get('SELECT * FROM participants WHERE id = ?', r.participantId); }));
  const round = C.upsertRound(db, E, { title: 'R1', kind: 'quiz' });
  return { db, live, clock, E, teams, people, round, ownerToken, event: db.get('SELECT * FROM events WHERE id = ?', E) };
}
const seqOf = (live, E) => live.state(E).seq;
const run = (live, E, action, extra = {}) => live.action(E, 'test', { action, seq: seqOf(live, E), ...extra });

test('scoreformules', () => {
  assert.equal(speedScore(0, 20), 1000);
  assert.equal(speedScore(10000, 20), 750);
  assert.equal(speedScore(20000, 20), 500);
  assert.equal(speedScore(25000, 20), 500);
  const items = [{ v: 10 }, { v: 7 }, { v: 7 }, { v: 3 }];
  assert.deepEqual(items.map(i => competitionRanks(items, x => x.v).get(i)), [1, 2, 2, 4]);
  assert.equal(normalize('  Het Bami-Goreng! '), 'bami goreng');
  assert.equal(judgeOpen('bami goreng', ['Bami goreng']), 'correct');
  assert.equal(judgeOpen('bamigorng', ['bamigoreng']), 'review');
  assert.equal(judgeOpen('nasi', ['bami goreng']), 'wrong');
});

test('volledige meerkeuze-flow: open → indienen → sluiten → onthullen → scoren', () => {
  const { db, live, clock, E, people, round } = setup();
  const q = C.upsertQuestion(db, E, { roundId: round, type: 'mc', prompt: 'Hoofdstad?', options: ['Den Haag', 'Amsterdam'], seconds: 20, points: 2, key: { correct: 1 } });
  run(live, E, 'prepare', { questionId: q });
  run(live, E, 'open');
  // vóór geplande start: geweigerd
  assert.throws(() => live.submit(E, people.a1, { questionId: q, answer: 1 }), /nog niet geopend/);
  clock.add(3000);
  // niet-captain mag geen teamantwoord sturen
  assert.throws(() => live.submit(E, people.a2, { questionId: q, answer: 1 }), /captain/);
  const r1 = live.submit(E, people.a1, { questionId: q, answer: 1 });
  assert.equal(r1.duplicate, false);
  // dubbele tap / tweede tabblad: zelfde inzending, geen tweede
  const r2 = live.submit(E, people.a1, { questionId: q, answer: 0 });
  assert.equal(r2.duplicate, true);
  assert.equal(JSON.parse(r2.submission.answer), 1);
  live.submit(E, people.b1, { questionId: q, answer: 0 });
  // ongeldige keuze
  assert.throws(() => live.submit(E, people.c1, { questionId: q, answer: 7 }), /Ongeldige keuze/);
  clock.add(21000);
  assert.throws(() => live.submit(E, people.c1, { questionId: q, answer: 1 }), /Te laat/);
  run(live, E, 'close');
  run(live, E, 'reveal');
  run(live, E, 'score');
  let sb = live.scoreboard(E);
  assert.equal(sb.teams.find(t => t.name === 'A').points, 2);
  assert.equal(sb.teams.find(t => t.name === 'B').points, 0);
  // opnieuw scoren telt niet dubbel
  run(live, E, 'score'); run(live, E, 'score');
  sb = live.scoreboard(E);
  assert.equal(sb.teams.find(t => t.name === 'A').points, 2);
  assert.equal(db.get("SELECT COUNT(*) n FROM score_events WHERE voided_at IS NULL").n, 1);
});

test('dubbele klik / verouderd scherm wordt geweigerd', () => {
  const { db, live, E, round } = setup();
  const q = C.upsertQuestion(db, E, { roundId: round, type: 'tf', prompt: 'x', seconds: 10, key: { correct: 0 } });
  const s0 = seqOf(live, E);
  live.action(E, 't', { action: 'prepare', questionId: q, seq: s0 });
  live.action(E, 't', { action: 'open', seq: s0 + 1 });
  assert.throws(() => live.action(E, 't', { action: 'open', seq: s0 + 1 }), /achter/);
  assert.throws(() => live.action(E, 't', { action: 'next', seq: s0 + 2 }), /Onbekende actie/);
  // nieuwe vraag kan niet starten terwijl er een openstaat
  assert.throws(() => live.action(E, 't', { action: 'prepare', questionId: q, seq: s0 + 2 }), /Sluit eerst/);
});

test('pauze bevriest de tijd en schuift de deadline op', () => {
  const { db, live, clock, E, people, round } = setup();
  const q = C.upsertQuestion(db, E, { roundId: round, type: 'mc', scope: 'individual', scoring: 'speed', prompt: 'x', options: ['a', 'b'], seconds: 20, key: { correct: 0 } });
  run(live, E, 'prepare', { questionId: q }); run(live, E, 'open');
  clock.add(3000 + 5000);
  run(live, E, 'pause');
  assert.throws(() => live.submit(E, people.a1, { questionId: q, answer: 0 }), /gepauzeerd/);
  clock.add(60000);
  run(live, E, 'resume');
  clock.add(4000);
  const r = live.submit(E, people.a1, { questionId: q, answer: 0 });
  assert.equal(r.submission.elapsed_ms, 9000); // 5s + 4s, pauze telt niet
  clock.add(12000); // 5 + 4 + 12 = 21 s speeltijd > 20 s
  assert.throws(() => live.submit(E, people.a2, { questionId: q, answer: 0 }), /Te laat/);
});

test('bliksemronde: sneller goed = meer, fout = 0, individueel bord, laat geweigerd', () => {
  const { db, live, clock, E, people, round } = setup();
  const q = C.upsertQuestion(db, E, { roundId: round, type: 'mc', scope: 'individual', scoring: 'speed', prompt: 'x', options: ['a', 'b', 'c'], seconds: 20, key: { correct: 2 } });
  run(live, E, 'prepare', { questionId: q }); run(live, E, 'open');
  clock.add(3000 + 2000); live.submit(E, people.a1, { questionId: q, answer: 2 });
  clock.add(8000); live.submit(E, people.a2, { questionId: q, answer: 2 });
  live.submit(E, people.b1, { questionId: q, answer: 0 });
  clock.add(11000);
  assert.throws(() => live.submit(E, people.b2, { questionId: q, answer: 2 }), /Te laat/);
  run(live, E, 'close'); run(live, E, 'reveal'); run(live, E, 'score');
  const sb = live.scoreboard(E);
  const pts = n => sb.individuals.find(p => p.name === n).points;
  assert.equal(pts('a1'), 500 + Math.floor(500 * (1 - 2 / 20)));
  assert.equal(pts('a2'), 500 + Math.floor(500 * (1 - 10 / 20)));
  assert.ok(pts('a1') > pts('a2'));
  assert.equal(pts('b1'), 0);
  assert.ok(sb.teams.every(t => t.points === 0), 'bliksempunten tellen niet automatisch mee voor teams');
});

test('pauzetest: inzending na verschoven deadline is te laat', () => {
  const { db, live, clock, E, people, round } = setup();
  const q = C.upsertQuestion(db, E, { roundId: round, type: 'mc', scope: 'individual', prompt: 'x', options: ['a', 'b'], seconds: 20, key: { correct: 0 } });
  run(live, E, 'prepare', { questionId: q }); run(live, E, 'open');
  clock.add(3000 + 10000); run(live, E, 'pause'); clock.add(30000); run(live, E, 'resume');
  clock.add(9000); live.submit(E, people.a1, { questionId: q, answer: 0 });
  clock.add(2000); assert.throws(() => live.submit(E, people.a2, { questionId: q, answer: 0 }), /Te laat/);
});

test('dichtstbij met gelijke afwijking: 5,5,3,2,1', () => {
  const { db, live, clock, E, people, round } = setup();
  const q = C.upsertQuestion(db, E, { roundId: round, type: 'number', scoring: 'closest', prompt: 'gram?', seconds: 30, key: { correct: 250 } });
  run(live, E, 'prepare', { questionId: q }); run(live, E, 'open'); clock.add(3500);
  [['a1', 245], ['b1', 255], ['c1', 230], ['d1', 300], ['e1', 400]].forEach(([n, v]) => live.submit(E, people[n], { questionId: q, answer: v }));
  run(live, E, 'close'); run(live, E, 'reveal'); run(live, E, 'score');
  const sb = live.scoreboard(E); const p = n => sb.teams.find(t => t.name === n).points;
  assert.deepEqual(['A', 'B', 'C', 'D', 'E'].map(p), [5, 5, 3, 2, 1]);
});

test('inzet: goed erbij, fout eraf met minimum 0', () => {
  const { db, live, clock, E, people, teams, round } = setup();
  const q = C.upsertQuestion(db, E, { roundId: round, type: 'mc', prompt: 'x', options: ['a', 'b'], seconds: 20, points: 1, allowBet: true, key: { correct: 0 } });
  live.adjust(E, 'test', { teamId: teams[1], points: 2, reason: 'startpunten' });
  run(live, E, 'prepare', { questionId: q }); run(live, E, 'open'); clock.add(3500);
  live.submit(E, people.a1, { questionId: q, answer: 0, bet: 3 });   // goed: 1 + 3
  live.submit(E, people.b1, { questionId: q, answer: 1, bet: 3 });   // fout, had 2 → naar 0
  assert.throws(() => live.submit(E, people.c1, { questionId: q, answer: 0, bet: 5 }), /1, 2 of 3/);
  run(live, E, 'close'); run(live, E, 'reveal'); run(live, E, 'score');
  const sb = live.scoreboard(E); const p = n => sb.teams.find(t => t.name === n).points;
  assert.equal(p('A'), 4); assert.equal(p('B'), 0);
});

test('open antwoord: twijfel naar host, handmatig oordeel herscoort zonder dubbeling', () => {
  const { db, live, clock, E, people, round } = setup();
  const q = C.upsertQuestion(db, E, { roundId: round, type: 'open', prompt: 'gerecht?', seconds: 30, points: 1, key: { correct: 'bami goreng', accepted: ['bami'] } });
  run(live, E, 'prepare', { questionId: q }); run(live, E, 'open'); clock.add(3500);
  live.submit(E, people.a1, { questionId: q, answer: 'Bami!' });
  live.submit(E, people.b1, { questionId: q, answer: 'bami gorang' });
  run(live, E, 'close'); run(live, E, 'reveal');
  const subB = db.get("SELECT * FROM submissions WHERE owner_key LIKE 't:%' AND verdict = 'review'");
  assert.ok(subB, 'typfout gaat als twijfel naar de host');
  run(live, E, 'score');
  live.judge(E, 'host', subB.id, 'correct');
  live.judge(E, 'host', subB.id, 'correct');
  const sb = live.scoreboard(E);
  assert.equal(sb.teams.find(t => t.name === 'A').points, 1);
  assert.equal(sb.teams.find(t => t.name === 'B').points, 1);
});

test('correcties vereisen reden en blijven herleidbaar; vervallen regel telt niet', () => {
  const { live, E, teams } = setup();
  assert.throws(() => live.adjust(E, 't', { teamId: teams[0], points: 3, reason: '' }), /reden/);
  const e = live.adjust(E, 't', { teamId: teams[0], points: 3, reason: 'outfit' });
  assert.equal(live.scoreboard(E).teams.find(t => t.id === teams[0]).points, 3);
  live.voidScoreEvent(E, 't', e.id, 'vergissing');
  assert.equal(live.scoreboard(E).teams.find(t => t.id === teams[0]).points, 0);
  assert.throws(() => live.voidScoreEvent(E, 't', e.id, 'nogmaals'), /al vervallen/);
});

test('captain: overdracht alleen door huidige captain, één captain per team', () => {
  const { db, live, E, people } = setup();
  assert.throws(() => live.setCaptain(E, 'p', people.e3.id, { byParticipant: people.e2.id }), /huidige captain/);
  live.setCaptain(E, 'p', people.e3.id, { byParticipant: people.e1.id });
  const caps = db.all("SELECT participant_id FROM memberships m JOIN teams t ON t.id = m.team_id WHERE t.name = 'E' AND is_captain = 1");
  assert.deepEqual(caps.map(c => c.participant_id), [people.e3.id]);
});

test('geheimhouding: speler en tv zien geen antwoord vóór onthulling; spoilervrij ziet geen inhoud', () => {
  const { db, live, clock, E, people, round, event } = setup();
  const q = C.upsertQuestion(db, E, { roundId: round, type: 'mc', prompt: 'GEHEIM-VRAAG', options: ['x', 'GEHEIM-OPTIE'], seconds: 20, key: { correct: 1, explanation: 'GEHEIM-UITLEG' } });
  const { token: sfTok } = createGrant(db, E, 'spoilerfree', 'Reno');
  const { token: hostTok } = createGrant(db, E, 'host', 'Host');
  const sf = staffByToken(db, sfTok), host = staffByToken(db, hostTok);
  const pv = () => JSON.stringify(playerView(live, { participant: people.a1, event }, new Set()));
  const dv = () => JSON.stringify(displayView(live, event, new Set(), 'x'));
  const sv = () => JSON.stringify(staffView(live, sf, new Set(), 'x'));
  const hv = () => JSON.stringify(staffView(live, host, new Set(), 'x'));
  run(live, E, 'prepare', { questionId: q });
  for (const f of [pv, dv, sv]) { assert.ok(!f().includes('GEHEIM-VRAAG'), 'vraag niet zichtbaar vóór openen'); }
  run(live, E, 'open');
  assert.ok(!pv().includes('GEHEIM-OPTIE'), 'keuzes pas op geplande start');
  clock.add(3000);
  assert.ok(pv().includes('GEHEIM-OPTIE'));
  for (const f of [pv, dv, hv]) { const s = f(); assert.ok(!s.includes('GEHEIM-UITLEG') && !s.includes('"correct":1'), 'geen sleutel tijdens open vraag'); }
  assert.ok(!sv().includes('GEHEIM'), 'spoilervrij ziet niets van de inhoud');
  run(live, E, 'close');
  assert.ok(hv().includes('GEHEIM-UITLEG'), 'host ziet sleutel na sluiten');
  assert.ok(!pv().includes('GEHEIM-UITLEG'), 'speler nog niet');
  run(live, E, 'reveal');
  assert.ok(pv().includes('GEHEIM-UITLEG'), 'speler na onthulling');
  assert.ok(!sv().includes('GEHEIM'), 'spoilervrij ook na onthulling geen inhoud in beheer');
});

test('dupliceren kopieert geen antwoorden, scores of sessies', () => {
  const { db, live, clock, E, people, round, teams } = setup();
  const q = C.upsertQuestion(db, E, { roundId: round, type: 'tf', prompt: 'x', seconds: 10, key: { correct: 0 } });
  run(live, E, 'prepare', { questionId: q }); run(live, E, 'open'); clock.add(3500);
  live.submit(E, people.a1, { questionId: q, answer: 0 });
  run(live, E, 'close'); run(live, E, 'reveal'); run(live, E, 'score');
  live.adjust(E, 't', { teamId: teams[0], points: 1, reason: 'x' });
  const r = C.duplicateEvent(db, E, { name: 'Kopie', includeTeams: true, includeParticipants: true });
  const N = r.event.id;
  const n = (sql) => db.get(sql, N).n;
  assert.equal(n('SELECT COUNT(*) n FROM questions WHERE event_id = ?'), 1);
  assert.equal(n('SELECT COUNT(*) n FROM teams WHERE event_id = ?'), 5);
  assert.equal(n('SELECT COUNT(*) n FROM submissions WHERE event_id = ?'), 0);
  assert.equal(n('SELECT COUNT(*) n FROM score_events WHERE event_id = ?'), 0);
  assert.equal(n('SELECT COUNT(*) n FROM participants WHERE event_id = ? AND token_hash IS NOT NULL'), 0);
  assert.notEqual(r.event.join_code, db.get('SELECT join_code FROM events WHERE id = ?', E).join_code);
});

test('ongeldig verklaren laat punten vervallen met reden', () => {
  const { db, live, clock, E, people, round } = setup();
  const q = C.upsertQuestion(db, E, { roundId: round, type: 'tf', prompt: 'x', seconds: 10, key: { correct: 0 } });
  run(live, E, 'prepare', { questionId: q }); run(live, E, 'open'); clock.add(3500);
  live.submit(E, people.a1, { questionId: q, answer: 0 });
  run(live, E, 'close'); run(live, E, 'reveal'); run(live, E, 'score');
  assert.equal(live.scoreboard(E).teams.find(t => t.name === 'A').points, 1);
  run(live, E, 'void', { reason: 'wifi lag eruit' });
  assert.equal(live.scoreboard(E).teams.find(t => t.name === 'A').points, 0);
  assert.match(db.get('SELECT voided_reason FROM score_events').voided_reason, /wifi/);
});

test('een gespeelde vraag kan niet opnieuw worden klaargezet; volgende slaat hem over', () => {
  const { db, live, clock, E, people, round } = setup();
  const q1 = C.upsertQuestion(db, E, { roundId: round, type: 'tf', prompt: '1', seconds: 10, key: { correct: 0 } });
  const q2 = C.upsertQuestion(db, E, { roundId: round, type: 'tf', prompt: '2', seconds: 10, key: { correct: 0 } });
  run(live, E, 'prepare', { questionId: q1 }); run(live, E, 'open'); clock.add(3500);
  live.submit(E, people.a1, { questionId: q1, answer: 0 });
  run(live, E, 'close');
  assert.equal(live.nextQuestionId(E), q2);
  assert.throws(() => run(live, E, 'prepare', { questionId: q1 }), /al gespeeld/);
});

test('Na een rondetitel gaat "volgende vraag" naar die ronde, ook als een eerdere vraag geen antwoorden kreeg', () => {
  const { db, live, E, round } = setup();
  const qa = C.upsertQuestion(db, E, { roundId: round, type: 'mc', prompt: 'A?', options: ['x', 'y'], key: { correct: 0 } });
  const r2 = C.upsertRound(db, E, { title: 'R2', kind: 'quiz' });
  const qb = C.upsertQuestion(db, E, { roundId: r2, type: 'mc', prompt: 'B?', options: ['x', 'y'], key: { correct: 0 } });
  run(live, E, 'prepare', { questionId: qa }); // niemand antwoordt op A
  run(live, E, 'round_intro', { roundId: r2 });
  assert.equal(live.nextQuestionId(E), qb);
});
