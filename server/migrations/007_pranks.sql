-- Pestkaarten: per team per avond één van elke kaart (steeljoker, bevriezen, tijdbom, shotkaart, schild).
CREATE TABLE pranks (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  question_id TEXT REFERENCES questions(id) ON DELETE CASCADE,
  card TEXT NOT NULL,
  by_team TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  target_team TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  played_by TEXT,
  until_ms INTEGER,          -- bevriezen: tot dit moment (ms na opening); tijdbom: eigen deadline (ms na opening)
  blocked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (event_id, by_team, card)
);
CREATE INDEX idx_pranks_q ON pranks(question_id);
