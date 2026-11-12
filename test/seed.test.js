import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, json } from '../server/db.js';
import * as C from '../server/content.js';
import { seedMuchachos, sealedBeforeFinal } from '../server/seed-muchachos.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'seed');
const quiet = { log: () => {} };

test('Startinhoud: lege server krijgt avond, duo\'s, vragen, verzegelde ronde, dossier en berichten; tweede keer niets', () => {
  const db = openDb(':memory:');
  const now = Date.UTC(2026, 10, 12, 16, 0);
  const r = seedMuchachos(db, dir, { now, ...quiet });
  assert.ok(r.created);
  const E = r.event;
  assert.equal(db.get('SELECT COUNT(*) AS n FROM teams WHERE event_id = ?', E).n, 5);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM participants WHERE event_id = ?', E).n, 10);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM memberships m JOIN participants p ON p.id = m.participant_id WHERE p.event_id = ?', E).n, 10);
  assert.ok(r.rounds >= 9 && r.questions >= 80);
  assert.equal(r.sealedRounds, 1);
  assert.ok(db.all('SELECT settings FROM rounds WHERE event_id = ?', E).some(x => json(x.settings, {}).sealed));
  const st = json(db.get('SELECT settings FROM events WHERE id = ?', E).settings, {});
  assert.ok(st.questionnaire.length >= 15); assert.ok(st.dossier.intro.title);
  const msgs = db.all('SELECT send_at FROM messages WHERE event_id = ? ORDER BY send_at', E);
  assert.equal(msgs.length, 10); assert.ok(msgs[0].send_at > now);
  assert.equal(seedMuchachos(db, dir, { now, ...quiet }), null);
  // aanmelden met naam uit de lijst = direct in het goede duo
  const ev = db.get('SELECT * FROM events WHERE id = ?', E);
  const j = C.joinEvent(db, { code: ev.join_code, name: 'job van zoggel' });
  assert.equal(db.get('SELECT t.name FROM memberships m JOIN teams t ON t.id = m.team_id WHERE m.participant_id = ?', j.participantId).name, 'Robin & Job');
});

test('Startinhoud: bestaande avond wordt aangevuld zonder dubbelen; bericht in het verleden schuift naar straks', () => {
  const db = openDb(':memory:');
  const { event } = C.createEvent(db, { name: 'Mijn avond' });
  const t = C.upsertTeam(db, event.id, { name: 'Peter & Milan' });
  C.upsertParticipant(db, event.id, { name: 'Peter Laros' });
  C.upsertRound(db, event.id, { title: 'Algemene kennis', kind: 'quiz' });
  const now = Date.UTC(2026, 10, 14, 12, 0); // na het eerste bericht (13 nov 17:00)
  const r = seedMuchachos(db, dir, { now, ...quiet });
  assert.equal(r.event, event.id); assert.ok(!r.created);
  assert.equal(r.teams, 4); assert.equal(r.people, 9);
  assert.equal(db.get('SELECT team_id FROM memberships m JOIN participants p ON p.id = m.participant_id WHERE p.name = ?', 'Peter Laros').team_id, t);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM rounds WHERE event_id = ? AND title = 'Algemene kennis'", event.id).n, 1);
  const first = db.get('SELECT send_at FROM messages WHERE event_id = ? ORDER BY send_at LIMIT 1', event.id).send_at;
  assert.ok(first > now && first - now <= 20 * 60_000);
});

test('Verzegelde ronde schuift vóór de Finale', () => {
  const db = openDb(':memory:');
  const r = seedMuchachos(db, dir, { now: Date.UTC(2026, 10, 12), ...quiet });
  assert.equal(sealedBeforeFinal(db, quiet), 1);
  const rs = db.all('SELECT kind, settings FROM rounds WHERE event_id = ? ORDER BY sort', r.event);
  assert.equal(rs.at(-1).kind, 'final'); assert.ok(json(rs.at(-2).settings, {}).sealed);
  assert.equal(sealedBeforeFinal(db, quiet), 0);
});

test('De jongens: wie moet nog wat, seintjes alleen naar wie het moet, bericht aan één speler', async () => {
  const MSG = await import('../server/messages.js');
  const db = openDb(':memory:');
  const r = seedMuchachos(db, dir, { now: Date.UTC(2026, 10, 12), ...quiet });
  const ev = db.get('SELECT * FROM events WHERE id = ?', r.event);
  const a = C.joinEvent(db, { code: ev.join_code, name: 'Peter Laros' });
  const b = C.joinEvent(db, { code: ev.join_code, name: 'Milan Dellenman' });
  db.run('UPDATE participants SET profile = ? WHERE id = ?', JSON.stringify({ done: true }), b.participantId);
  const todo = MSG.playerTodo(db, r.event);
  const peter = todo.find(p => p.name === 'Peter Laros'), milan = todo.find(p => p.name === 'Milan Dellenman'), erik = todo.find(p => p.name === 'Erik Thus');
  assert.ok(peter.joined && peter.dossier === false && peter.voted === false);
  assert.ok(milan.dossier === true && !milan.missing.some(m => m.key === 'vragenlijst'));
  assert.equal(erik.missing[0].key, 'join');
  const res = MSG.remindLaggards(db, r.event);
  assert.equal(res.sent, 2); assert.equal(res.notJoined.length, 8);
  await MSG.deliverDue(db, Date.now() + 1000, { push: false });
  assert.ok(MSG.playerMessages(db, r.event, a.participantId).some(m => /Hoi Peter, je moet nog: het spelersdossier invullen/.test(m.body)));
  assert.ok(!MSG.playerMessages(db, r.event, b.participantId).some(m => /Hoi Peter/.test(m.body)));
  MSG.upsertMessage(db, r.event, { title: 'Alleen voor Milan', body: 'x', to: [b.participantId] });
  await MSG.deliverDue(db, Date.now() + 1000, { push: false });
  assert.ok(MSG.playerMessages(db, r.event, b.participantId).some(m => m.title === 'Alleen voor Milan'));
  assert.ok(!MSG.playerMessages(db, r.event, a.participantId).some(m => m.title === 'Alleen voor Milan'));
});
