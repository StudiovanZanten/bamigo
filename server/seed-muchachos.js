// Startinhoud voor de Muchacho's editie: één keer inladen bij het opstarten (idempotent).
// Vult een bestaande (echte) avond aan, of maakt er een. Dubbelen worden overgeslagen:
// rondes op titel, teams en spelers op naam, berichten op titel.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { json } from './db.js';
import * as C from './content.js';
import { importPack } from './exporting.js';
import { upsertMessage, localToEpoch, epochToLocal } from './messages.js';
import { upsertMission } from './modules.js';

const KEY = 'seed:muchachos:v1';

export function seedMuchachos(db, dir, { now = Date.now(), log = console.log } = {}) {
  const file = path.join(dir, 'muchachos.json');
  if (!fs.existsSync(file)) return null;
  if (db.get('SELECT 1 FROM kv WHERE key = ?', KEY)) return null;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const secretFile = path.join(dir, 'verzegeld.dat');
  const secret = fs.existsSync(secretFile) ? JSON.parse(zlib.gunzipSync(Buffer.from(fs.readFileSync(secretFile, 'utf8'), 'base64')).toString('utf8')) : null;

  const out = db.tx(() => {
    // 1. Avond: bestaande echte avond (met de meeste inhoud/spelers), anders nieuw.
    const evs = db.all("SELECT e.*, (SELECT COUNT(*) FROM questions q WHERE q.event_id = e.id) + (SELECT COUNT(*) FROM participants p WHERE p.event_id = e.id) AS weight FROM events e WHERE e.is_demo = 0 AND e.status NOT IN ('archived', 'finished') ORDER BY weight DESC, e.updated_at DESC");
    let ev = evs[0]; let created = false;
    if (!ev) { ev = C.createEvent(db, { name: data.event.name, startsAt: data.event.startsAt }).event; created = true; }
    else if (!ev.starts_at) C.updateEvent(db, ev.id, { startsAt: data.event.startsAt });
    const E = ev.id;

    // 2. Duo's en spelers (spelers kiezen bij aanmelden hun naam en komen zo in het goede duo).
    let teams = 0, people = 0;
    for (const [tname, names] of data.teams) {
      let t = db.get('SELECT id FROM teams WHERE event_id = ? AND name = ? COLLATE NOCASE', E, tname)?.id;
      if (!t) { t = C.upsertTeam(db, E, { name: tname }); teams++; }
      for (const n of names) {
        const p = db.get('SELECT id FROM participants WHERE event_id = ? AND name = ? COLLATE NOCASE', E, n);
        if (!p) { C.upsertParticipant(db, E, { name: n, teamId: t }); people++; }
        else if (!db.get('SELECT 1 FROM memberships WHERE participant_id = ?', p.id)) C.setTeam(db, E, p.id, t);
      }
    }

    // 3. Vragen + verzegelde ronde: alleen rondes die er (op titel) nog niet staan.
    const have = new Set(db.all('SELECT title FROM rounds WHERE event_id = ?', E).map(r => String(r.title).toLowerCase()));
    const fresh = p => ({ format: p.format, rounds: p.rounds.filter(r => !have.has(String(r.title).toLowerCase())) });
    const a = fresh(data.pack); const ra = a.rounds.length ? importPack(db, E, a) : { rounds: 0, questions: 0 };
    let sealed = { rounds: 0, questions: 0 };
    if (secret) { const b = fresh(secret); if (b.rounds.length) sealed = importPack(db, E, b); }

    // 4. Spelersdossier (alleen als er nog geen vragenlijst staat).
    const st = json(db.get('SELECT settings FROM events WHERE id = ?', E).settings, {});
    let dossier = false;
    if (!(st.questionnaire || []).length && data.dossier) { C.updateEvent(db, E, { settings: { questionnaire: data.dossier.items, dossier: { intro: data.dossier.intro, outro: data.dossier.outro } } }); dossier = true; }

    // 5. Berichten: ontbrekende inplannen; een tijdstip dat al voorbij is schuift naar het eerstvolgende hele kwartier.
    const titles = new Set(db.all('SELECT title FROM messages WHERE event_id = ?', E).map(m => m.title));
    let msgs = 0;
    for (const m of data.messages || []) {
      if (titles.has(m.title)) continue;
      let at = localToEpoch(m.sendAt);
      if (at <= now + 60_000) at = Math.ceil((now + 5 * 60_000) / 900_000) * 900_000;
      upsertMessage(db, E, { ...m, sendAt: epochToLocal(at) }); msgs++;
    }
    db.run('INSERT INTO kv (key, value) VALUES (?, ?)', KEY, JSON.stringify({ at: now, event: E }));
    return { event: E, created, teams, people, rounds: ra.rounds, questions: ra.questions, sealedRounds: sealed.rounds, dossier, messages: msgs };
  });
  log(`Startinhoud Muchacho's editie ingeladen: ${JSON.stringify(out)}`);
  return out;
}

/** Verzegelde rondes ("Versla Rinus!") die achter de Finale staan, schuiven naar vlak vóór de Finale. Eenmalig per avond; gespeelde rondes blijven staan. */
export function sealedBeforeFinal(db, { log = console.log } = {}) {
  const KEY2 = 'fix:sealed-before-final:v1';
  if (db.get('SELECT 1 FROM kv WHERE key = ?', KEY2)) return 0;
  let moved = 0;
  db.tx(() => {
    for (const ev of db.all('SELECT id FROM events WHERE is_demo = 0')) {
      const rounds = db.all('SELECT * FROM rounds WHERE event_id = ? ORDER BY sort, id', ev.id).map(r => ({ ...r, settings: json(r.settings, {}) }));
      const fin = rounds.find(r => r.kind === 'final'); if (!fin) continue;
      const played = rid => db.get('SELECT 1 FROM submissions s JOIN questions q ON q.id = s.question_id WHERE q.round_id = ? LIMIT 1', rid);
      const late = rounds.filter(r => r.settings.sealed && r.sort > fin.sort && !played(r.id));
      if (!late.length || played(fin.id)) continue;
      const order = rounds.filter(r => !late.includes(r));
      order.splice(order.indexOf(fin), 0, ...late);
      order.forEach((r, i) => db.run('UPDATE rounds SET sort = ? WHERE id = ?', (i + 1) * 10, r.id));
      moved += late.length;
    }
    db.run('INSERT INTO kv (key, value) VALUES (?, ?)', KEY2, JSON.stringify({ moved }));
  });
  if (moved) log(`Verzegelde ronde vóór de Finale gezet (${moved}).`);
  return moved;
}

/** Buitentas-missies (per duo, met foto als bewijs). Eenmalig; missies die er op titel al staan worden overgeslagen. */
export function seedMissions(db, dir, { log = console.log } = {}) {
  const KEY3 = 'seed:muchachos:missions:v1';
  const file = path.join(dir, 'muchachos.json');
  if (!fs.existsSync(file) || db.get('SELECT 1 FROM kv WHERE key = ?', KEY3)) return null;
  const list = JSON.parse(fs.readFileSync(file, 'utf8')).missions || [];
  let added = 0;
  db.tx(() => {
    const ev = db.get('SELECT value FROM kv WHERE key = ?', KEY);
    const E = ev ? JSON.parse(ev.value).event : null;
    if (E && db.get('SELECT 1 FROM events WHERE id = ?', E)) {
      const have = new Set(db.all('SELECT title FROM missions WHERE event_id = ?', E).map(m => m.title.toLowerCase()));
      list.forEach((m, i) => {
        if (have.has(m.title.toLowerCase())) return;
        const mid = upsertMission(db, E, m); db.run('UPDATE missions SET sort = ? WHERE id = ?', (i + 1) * 10, mid); added++;
      });
    }
    db.run('INSERT INTO kv (key, value) VALUES (?, ?)', KEY3, JSON.stringify({ added }));
  });
  if (added) log(`Buitentas-missies ingeladen: ${added}.`);
  return added;
}

/** Buitentas naar 3 missies: "Mysterieus huishoudelijk voorwerp" eruit, en de twee berichten die hem noemden bijwerken
 *  (alleen als ze nog niet verstuurd zijn en nog de oude tekst hebben). Eenmalig. */
const BT_OLD = {"Opdracht: de Buitentas": "Kassabon zo dicht mogelijk bij 12:00, een voorwerp van precies 250 gram, een mysterieus huishoudelijk voorwerp en de krant van 28 december. Vink af en voeg een foto toe.", "Nog 7 dagen": "Nog 7 dagen. Zaterdag 23 januari om 20:00 gaat het los. Vergeet de Buitentas niet: kassabon, 250 gram, mysterieus voorwerp en de krant. De vragen liggen klaar. Het bewijsmateriaal ook. Geen verdere vragen. VAMOSSS!"};
const BT_NEW = {"Opdracht: de Buitentas": "Kassabon zo dicht mogelijk bij 12:00, een voorwerp van precies 250 gram en de krant van 28 december. Vink af en voeg een foto toe.", "Nog 7 dagen": "Nog 7 dagen. Zaterdag 23 januari om 20:00 gaat het los. Vergeet de Buitentas niet: kassabon, 250 gram en de krant. De vragen liggen klaar. Het bewijsmateriaal ook. Geen verdere vragen. VAMOSSS!"};
export function buitentasDrie(db, { log = console.log } = {}) {
  const K = 'fix:buitentas-3:v1';
  if (db.get('SELECT 1 FROM kv WHERE key = ?', K)) return null;
  let missions = 0, msgs = 0;
  db.tx(() => {
    missions = db.run("DELETE FROM missions WHERE lower(title) = 'mysterieus huishoudelijk voorwerp'").changes;
    for (const [title, body] of Object.entries(BT_NEW))
      msgs += db.run('UPDATE messages SET body = ? WHERE title = ? AND body = ? AND sent_at IS NULL', body, title, BT_OLD[title]).changes;
    db.run('INSERT INTO kv (key, value) VALUES (?, ?)', K, JSON.stringify({ missions, msgs }));
  });
  if (missions || msgs) log(`Buitentas bijgewerkt: ${missions} missie weg, ${msgs} berichten aangepast.`);
  return { missions, msgs };
}
