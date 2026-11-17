// Pestkaarten: elk team heeft per avond van elke kaart er één. Aan per avond via settings.pranks.
// Kaarten worden gespeeld tijdens een open teamvraag, op één ander team. Max. één kaart per team per vraag.
import { id, json } from './db.js';
import { HttpError, bad, deny } from './auth.js';

const conflict = (m, code = 'conflict') => { throw new HttpError(409, m, code); };

export const CARDS = {
  steal: { icon: '🦹', name: 'Steeljoker', text: 'Hebben jullie deze vraag goed? Dan pakken jullie punten af van het team dat je kiest.' },
  freeze: { icon: '❄️', name: 'Bevriezen', text: 'Het gekozen team kan 10 seconden lang niet antwoorden.' },
  bomb: { icon: '⏱️', name: 'Tijdbom', text: 'Het gekozen team houdt nog maar de helft van de resterende tijd over.' },
  shot: { icon: '🥃', name: 'Shotkaart', text: 'Het gekozen team neemt nu samen een shotje.' },
  shield: { icon: '🛡️', name: 'Schild', text: 'Werkt vanzelf: de eerste pestkaart tegen jullie ketst af.' },
};
export const CARD_KEYS = Object.keys(CARDS);
export const FREEZE_MS = 10000;
const STEAL_TYPES = ['mc', 'tf', 'open', 'number', 'order', 'match'];
const ANSWER_TYPES = [...STEAL_TYPES, 'career', 'ranking'];

export const settingsOf = (db, eventId) => json(db.get('SELECT settings FROM events WHERE id = ?', eventId)?.settings, {});
export const pranksOn = (db, eventId) => !!settingsOf(db, eventId).pranks;
export const stealPoints = (db, eventId) => Math.max(1, Math.min(10, Number(settingsOf(db, eventId).stealPoints) || 2));

/** Waarom kan deze kaart (nu) niet bij deze vraag? null = kan wel. */
function cardBlocker(card, q, s) {
  if (card === 'shield') return 'Het schild werkt vanzelf.';
  if (card === 'shot') return null;
  if (q.scope !== 'team' || !ANSWER_TYPES.includes(q.type) || q.scoring === 'speed') return 'Niet bij deze vraag.';
  if (card === 'steal' && (q.scoring !== 'fixed' || !STEAL_TYPES.includes(q.type))) return 'Stelen kan niet bij deze vraag.';
  if (card === 'bomb' && !s.deadline) return 'Deze vraag heeft geen klok.';
  return null;
}

/** Actieve (niet afgeketste) kaarten tegen een team bij een vraag. */
export function against(db, qid, teamId) {
  return db.all(`SELECT p.*, t.name AS by_name FROM pranks p JOIN teams t ON t.id = p.by_team WHERE p.question_id = ? AND p.target_team = ? AND p.card != 'shield' AND p.blocked = 0 ORDER BY p.created_at`, qid, teamId);
}

/** Controle bij insturen: bevroren of tijdbom afgegaan? */
export function checkSubmit(db, q, s, teamId, t) {
  if (!teamId || q.scope !== 'team') return;
  const el = t - s.open_at;
  for (const p of against(db, q.id, teamId)) {
    if (p.card === 'freeze' && el < p.until_ms) { const e = new HttpError(409, `❄️ Jullie zijn bevroren door ${p.by_name}. Nog ${Math.ceil((p.until_ms - el) / 1000)} s wachten!`, 'frozen'); e.retryIn = p.until_ms - el; throw e; }
    if (p.card === 'bomb' && el > p.until_ms) conflict(`⏱️ Te laat: de tijdbom van ${p.by_name} is afgegaan.`, 'late');
  }
}

/** Speel een kaart. Iedereen in het team mag een kaart spelen. */
export function play(db, s, q, eventId, participant, m, { card, target }, t) {
  if (!pranksOn(db, eventId)) bad('Pestkaarten staan uit.');
  if (!m) deny('Je zit nog niet in een team.');
  if (!CARDS[card]) bad('Onbekende kaart.');
  if (s.phase !== 'open' || s.paused || (s.deadline && t > s.deadline)) conflict('Kaarten spelen kan alleen terwijl de vraag open staat.', 'closed');
  const why = cardBlocker(card, q, s); if (why) bad(why);
  const mine = m.team_id;
  if (db.get(`SELECT 1 FROM pranks WHERE event_id = ? AND by_team = ? AND card = ?`, eventId, mine, card)) conflict('Die kaart hebben jullie al gespeeld.', 'used');
  if (db.get(`SELECT 1 FROM pranks WHERE question_id = ? AND by_team = ? AND card != 'shield'`, q.id, mine)) conflict('Jullie hebben bij deze vraag al een kaart gespeeld.', 'used');
  const tt = db.get('SELECT id, name FROM teams WHERE id = ? AND event_id = ?', String(target || ''), eventId);
  if (!tt || tt.id === mine) bad('Kies een ander team.');
  const el = Math.max(0, t - s.open_at);
  if (['freeze', 'bomb'].includes(card) && db.get('SELECT 1 FROM submissions WHERE question_id = ? AND owner_key = ?', q.id, 't:' + tt.id)) conflict(`${tt.name} heeft al geantwoord. Kies een ander team.`, 'done');
  let until = null;
  if (card === 'freeze') until = el + FREEZE_MS;
  if (card === 'bomb') { const left = s.deadline - Math.max(t, s.open_at); if (left < 4000) conflict('Te weinig tijd over voor een tijdbom.', 'late'); until = el + Math.round(left / 2); }
  // Schild van het doelwit ketst de eerste kaart af (schild is daarna op).
  const shielded = !db.get(`SELECT 1 FROM pranks WHERE event_id = ? AND by_team = ? AND card = 'shield'`, eventId, tt.id);
  const row = { id: id('k_'), card, until };
  db.run(`INSERT INTO pranks (id, event_id, question_id, card, by_team, target_team, played_by, until_ms, blocked, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    row.id, eventId, q.id, card, mine, tt.id, participant.id, until, shielded ? 1 : 0, t);
  if (shielded) db.run(`INSERT INTO pranks (id, event_id, question_id, card, by_team, target_team, played_by, until_ms, blocked, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id('k_'), eventId, q.id, 'shield', tt.id, mine, null, null, 0, t);
  return { ...row, blocked: shielded, target: tt.name };
}

/** Steeljoker scoren: goed = punten van het doelwit afpakken (doelwit niet onder 0). */
export function scoreSteals(db, eventId, q, subs, addM, teamTotal) {
  const pts = stealPoints(db, eventId);
  for (const p of db.all(`SELECT p.*, a.name AS by_name, b.name AS target_name FROM pranks p JOIN teams a ON a.id = p.by_team JOIN teams b ON b.id = p.target_team
    WHERE p.question_id = ? AND p.card = 'steal' AND p.blocked = 0`, q.id)) {
    const sub = subs.find(s => s.owner_key === 't:' + p.by_team);
    if (sub?.verdict !== 'correct') continue;
    const take = Math.min(pts, Math.max(0, teamTotal(p.target_team)));
    addM(p.by_team, null, 'team', 'steal:' + p.by_team, pts, `🦹 Steeljoker: ${pts} punten gestolen van ${p.target_name}`);
    if (take) addM(p.target_team, null, 'team', 'stolen:' + p.by_team, -take, `🦹 Bestolen door ${p.by_name}`);
  }
}

/** Openbaar overzicht van de kaarten bij een vraag (voor tv, telefoon en beheer). */
export function publicPranks(db, qid, { revealed = false } = {}) {
  if (!qid) return [];
  return db.all(`SELECT p.card, p.blocked, p.until_ms, p.by_team, p.target_team, a.name AS by_name, b.name AS target_name FROM pranks p JOIN teams a ON a.id = p.by_team JOIN teams b ON b.id = p.target_team
    WHERE p.question_id = ? ORDER BY p.created_at`, qid).map(p => {
    const out = { card: p.card, icon: CARDS[p.card]?.icon, name: CARDS[p.card]?.name, by: p.by_name, byTeam: p.by_team, target: p.target_name, targetTeam: p.target_team, blocked: !!p.blocked, untilMs: p.until_ms };
    if (p.card === 'steal' && revealed && !p.blocked) out.ok = db.get(`SELECT verdict FROM submissions WHERE question_id = ? AND owner_key = ?`, qid, 't:' + p.by_team)?.verdict === 'correct';
    return out;
  });
}

/** Kaartenhand voor een team bij de huidige vraag. */
export function hand(db, eventId, s, q, teamId) {
  if (!pranksOn(db, eventId) || !teamId) return null;
  const used = new Set(db.all('SELECT card FROM pranks WHERE event_id = ? AND by_team = ?', eventId, teamId).map(r => r.card));
  const here = q ? db.get(`SELECT card FROM pranks WHERE question_id = ? AND by_team = ? AND card != 'shield'`, q.id, teamId) : null;
  const open = q && s.phase === 'open' && !s.paused;
  return {
    stealPoints: stealPoints(db, eventId),
    playedHere: here?.card || null,
    cards: CARD_KEYS.map(k => {
      const why = !q ? 'Geen vraag actief.' : cardBlocker(k, q, s);
      return { key: k, ...CARDS[k], text: k === 'steal' ? `Hebben jullie deze vraag goed? Dan pakken jullie ${stealPoints(db, eventId)} punten af van het team dat je kiest.` : CARDS[k].text,
        used: used.has(k), playable: !used.has(k) && !here && open && !why, why: used.has(k) ? 'Al gespeeld.' : why };
    }),
    targets: db.all('SELECT id, name FROM teams WHERE event_id = ? AND id != ? ORDER BY sort, name', eventId, teamId),
  };
}
