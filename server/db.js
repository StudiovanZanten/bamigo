// Database: SQLite via de ingebouwde node:sqlite module (geen native afhankelijkheden).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return wrap(db);
}

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const dir = path.join(here, 'migrations');
  const done = new Set(db.prepare('SELECT name FROM schema_migrations').all().map(r => r.name));
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    db.exec('BEGIN');
    try {
      db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, Date.now());
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
}

function wrap(raw) {
  const cache = new Map();
  const st = sql => { let s = cache.get(sql); if (!s) { s = raw.prepare(sql); cache.set(sql, s); } return s; };
  const clean = r => (r ? { ...r } : r);
  let depth = 0;
  return {
    raw,
    get: (sql, ...p) => clean(st(sql).get(...p)),
    all: (sql, ...p) => st(sql).all(...p).map(clean),
    run: (sql, ...p) => st(sql).run(...p),
    exec: sql => raw.exec(sql),
    tx(fn) {
      if (depth > 0) return fn();
      raw.exec('BEGIN IMMEDIATE'); depth++;
      try { const r = fn(); raw.exec('COMMIT'); return r; }
      catch (e) { raw.exec('ROLLBACK'); throw e; }
      finally { depth--; }
    },
    close: () => raw.close(),
  };
}

export const id = (prefix = '') => prefix + crypto.randomBytes(9).toString('base64url');
export const now = () => Date.now();
export const json = (s, fallback = null) => { try { return s == null ? fallback : JSON.parse(s); } catch { return fallback; } };
