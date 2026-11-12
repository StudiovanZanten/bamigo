-- Berichten van BAMIGO aan spelers (ingepland), pushabonnementen en serverinstellingen.
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  send_at INTEGER NOT NULL,          -- epoch ms
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT,                         -- vragenlijst | ranking | shot | buitentas
  sent_at INTEGER,
  push_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_messages_due ON messages(sent_at, send_at);

CREATE TABLE push_subs (
  endpoint TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  sub TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_push_event ON push_subs(event_id);

CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
