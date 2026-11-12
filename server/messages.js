// Berichten van BAMIGO: ingeplande berichten aan alle spelers van een avond, met web-push.
import webpush from 'web-push';
import { id } from './db.js';
import { bad, notFound } from './auth.js';

export const LINKS = ['vragenlijst', 'ranking', 'shot', 'buitentas'];
const TZ = 'Europe/Amsterdam';

/** Offset (ms) van Nederlandse tijd t.o.v. UTC op moment `ts`. */
function tzOffset(ts) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ts)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ts / 1000) * 1000;
}
/** "2026-11-20T17:00" (Nederlandse tijd) → epoch ms. */
export function localToEpoch(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) bad('Ongeldige datum/tijd. Gebruik bijv. 2026-11-20T17:00.');
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return guess - tzOffset(guess - tzOffset(guess));
}
/** epoch ms → "2026-11-20T17:00" in Nederlandse tijd. */
export function epochToLocal(ts) {
  return new Date(ts + tzOffset(ts)).toISOString().slice(0, 16);
}

function clean(b) {
  const title = String(b.title ?? '').trim().slice(0, 120);
  if (!title) bad('Geef het bericht een titel.');
  const link = LINKS.includes(b.link) ? b.link : null;
  return { title, body: String(b.body ?? '').trim().slice(0, 1500), link, send_at: b.sendAt ? localToEpoch(b.sendAt) : Date.now() };
}

export function upsertMessage(db, eventId, b) {
  const c = clean(b || {});
  if (b.id) {
    const m = db.get('SELECT * FROM messages WHERE id = ? AND event_id = ?', b.id, eventId) || notFound('Bericht niet gevonden');
    if (m.sent_at) bad('Dit bericht is al verstuurd.');
    db.run('UPDATE messages SET title = ?, body = ?, link = ?, send_at = ? WHERE id = ?', c.title, c.body, c.link, c.send_at, m.id);
    return m.id;
  }
  const mid = id('m_');
  db.run('INSERT INTO messages (id, event_id, send_at, title, body, link, created_at) VALUES (?,?,?,?,?,?,?)', mid, eventId, c.send_at, c.title, c.body, c.link, Date.now());
  return mid;
}

export function importMessages(db, eventId, list) {
  if (!Array.isArray(list) || !list.length) bad('Verwacht een lijst met berichten.');
  if (list.length > 100) bad('Maximaal 100 berichten per keer.');
  return db.tx(() => list.map(b => upsertMessage(db, eventId, { ...b, id: undefined })).length);
}

export function deleteMessage(db, eventId, mid) {
  const r = db.run('DELETE FROM messages WHERE id = ? AND event_id = ?', mid, eventId);
  if (!r.changes) notFound('Bericht niet gevonden');
}

export function sendNow(db, eventId, mid) {
  const m = db.get('SELECT * FROM messages WHERE id = ? AND event_id = ?', mid, eventId) || notFound('Bericht niet gevonden');
  if (m.sent_at) bad('Dit bericht is al verstuurd.');
  db.run('UPDATE messages SET send_at = ? WHERE id = ?', Date.now(), m.id);
}

/** Overzicht voor beheer. */
export function staffMessages(db, eventId) {
  const subs = db.get('SELECT COUNT(DISTINCT participant_id) AS n FROM push_subs WHERE event_id = ?', eventId).n;
  return {
    pushPlayers: subs,
    list: db.all('SELECT * FROM messages WHERE event_id = ? ORDER BY send_at', eventId)
      .map(m => ({ id: m.id, title: m.title, body: m.body, link: m.link, sendAt: epochToLocal(m.send_at), sentAt: m.sent_at, pushCount: m.push_count })),
  };
}

/** Verstuurde berichten voor een speler (nieuwste eerst). */
export function playerMessages(db, eventId) {
  return db.all('SELECT id, title, body, link, sent_at FROM messages WHERE event_id = ? AND sent_at IS NOT NULL ORDER BY sent_at DESC LIMIT 50', eventId)
    .map(m => ({ id: m.id, title: m.title, body: m.body, link: m.link, sentAt: m.sent_at }));
}

// ---------- web-push ----------
let vapid = null;
export function vapidKeys(db, publicUrl) {
  if (vapid) return vapid;
  let pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    const row = db.get("SELECT value FROM kv WHERE key = 'vapid'");
    if (row) ({ pub, priv } = JSON.parse(row.value));
    else { const k = webpush.generateVAPIDKeys(); pub = k.publicKey; priv = k.privateKey; db.run("INSERT INTO kv (key, value) VALUES ('vapid', ?)", JSON.stringify({ pub, priv })); }
  }
  const subject = publicUrl && /^https:/.test(publicUrl) ? publicUrl : 'mailto:noreply@bamigo.invalid';
  webpush.setVapidDetails(subject, pub, priv);
  vapid = { publicKey: pub };
  return vapid;
}

export function saveSubscription(db, participant, sub) {
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) bad('Ongeldig meldingsabonnement.');
  const s = JSON.stringify({ endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } });
  if (s.length > 2000) bad('Ongeldig meldingsabonnement.');
  db.run(`INSERT INTO push_subs (endpoint, participant_id, event_id, sub, created_at) VALUES (?,?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET participant_id = excluded.participant_id, event_id = excluded.event_id, sub = excluded.sub`, sub.endpoint, participant.id, participant.event_id, s, Date.now());
}
export function removeSubscription(db, participant, endpoint) {
  db.run('DELETE FROM push_subs WHERE participant_id = ? AND endpoint = ?', participant.id, String(endpoint || ''));
}

/**
 * Lever berichten af die aan de beurt zijn. Markeert eerst als verstuurd (nooit dubbel),
 * daarna push naar alle abonnementen van die avond. Geeft de betrokken event-id's terug.
 */
export async function deliverDue(db, now = Date.now(), { push = true, baseUrl = '' } = {}) {
  const due = db.all('SELECT * FROM messages WHERE sent_at IS NULL AND send_at <= ? ORDER BY send_at LIMIT 20', now);
  const events = new Set();
  for (const m of due) {
    if (!db.run('UPDATE messages SET sent_at = ? WHERE id = ? AND sent_at IS NULL', now, m.id).changes) continue;
    events.add(m.event_id);
    if (!push || !vapid) continue;
    const payload = JSON.stringify({ title: m.title, body: m.body.slice(0, 300), url: baseUrl + '/speel' + (m.link ? '#taak=' + m.link : ''), tag: m.id });
    let ok = 0;
    for (const row of db.all('SELECT * FROM push_subs WHERE event_id = ?', m.event_id)) {
      try { await webpush.sendNotification(JSON.parse(row.sub), payload, { TTL: 60 * 60 * 24 }); ok++; }
      catch (e) { if (e.statusCode === 404 || e.statusCode === 410) db.run('DELETE FROM push_subs WHERE endpoint = ?', row.endpoint); }
    }
    db.run('UPDATE messages SET push_count = ? WHERE id = ?', ok, m.id);
  }
  return [...events];
}
