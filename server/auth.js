// Tokens en rollen. Tokens worden alleen gehasht opgeslagen.
import crypto from 'node:crypto';

export const newToken = () => crypto.randomBytes(24).toString('base64url');
export const hashToken = t => crypto.createHash('sha256').update(String(t)).digest('hex');

export const ROLES = {
  owner:       { label: 'Eigenaar', perms: ['event.manage', 'roles.manage', 'content.read', 'content.write', 'answers.read', 'people.write', 'live.control', 'scores.write', 'progress.read', 'secrets.read'] },
  content:     { label: 'Inhoudsbeheerder', perms: ['content.read', 'content.write', 'answers.read', 'people.write', 'live.control', 'scores.write', 'progress.read', 'secrets.read'] },
  host:        { label: 'Live host', perms: ['live.control', 'scores.write', 'people.write', 'progress.read', 'live.prompts'] },
  spoilerfree: { label: 'Spoilervrije organisator', perms: ['progress.read'] },
  display:     { label: 'TV-scherm', perms: ['display'] },
};

export const can = (role, perm) => !!ROLES[role]?.perms.includes(perm);

export class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
export const deny = (msg = 'Geen toegang') => { throw new HttpError(403, msg, 'forbidden'); };
export const bad = msg => { throw new HttpError(400, msg, 'bad_request'); };
export const notFound = (msg = 'Niet gevonden') => { throw new HttpError(404, msg, 'not_found'); };

/** Zoek een staff-sessie op token. Geeft {grant, event} of null. */
export function staffByToken(db, token) {
  if (!token) return null;
  const grant = db.get('SELECT * FROM role_grants WHERE token_hash = ? AND revoked = 0', hashToken(token));
  if (!grant) return null;
  const event = db.get('SELECT * FROM events WHERE id = ?', grant.event_id);
  return event ? { grant, event, role: grant.role } : null;
}

export function playerByToken(db, token) {
  if (!token) return null;
  const p = db.get('SELECT * FROM participants WHERE token_hash = ?', hashToken(token));
  if (!p) return null;
  const event = db.get('SELECT * FROM events WHERE id = ?', p.event_id);
  return event ? { participant: p, event } : null;
}

export function createGrant(db, eventId, role, label) {
  if (!ROLES[role]) bad('Onbekende rol');
  const token = newToken();
  const gid = 'g_' + crypto.randomBytes(9).toString('base64url');
  db.run('INSERT INTO role_grants (id, event_id, role, label, token_hash, created_at) VALUES (?,?,?,?,?,?)',
    gid, eventId, role, label || ROLES[role].label, hashToken(token), Date.now());
  return { id: gid, token, role };
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
