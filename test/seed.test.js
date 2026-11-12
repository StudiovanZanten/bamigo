import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, json } from '../server/db.js';
import * as C from '../server/content.js';
import { seedMuchachos } from '../server/seed-muchachos.js';

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
