-- BAMIGO schema v1
PRAGMA foreign_keys = ON;

CREATE TABLE templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  template_id TEXT REFERENCES templates(id),
  name TEXT NOT NULL,
  subtitle TEXT,
  starts_at TEXT,                 -- vrij in te vullen ISO-datum/tijd
  duration_target INTEGER NOT NULL DEFAULT 110,
  duration_max INTEGER NOT NULL DEFAULT 120,
  join_code TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL DEFAULT 'teams',   -- teams | individual
  settings TEXT NOT NULL DEFAULT '{}',  -- JSON: thema, humor, drank, puntenschema, oneliners...
  is_demo INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft', -- draft | live | finished | archived
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE role_grants (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  role TEXT NOT NULL,             -- owner | content | host | spoilerfree | display
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT,
  outfit TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE participants (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT UNIQUE,
  joined_at INTEGER,
  last_seen INTEGER,
  profile TEXT NOT NULL DEFAULT '{}', -- vragenlijst: grenzen humor, verhaal (privé)
  created_at INTEGER NOT NULL,
  UNIQUE(event_id, name)
);

CREATE TABLE memberships (
  participant_id TEXT PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  is_captain INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX one_captain_per_team ON memberships(team_id) WHERE is_captain = 1;

CREATE TABLE rounds (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'quiz',  -- quiz | brocode | ranking | kompaan | shots | missions | dragons | search | bluff | lightning | final | break
  title TEXT NOT NULL,
  instructions TEXT,
  supplies TEXT,
  minutes INTEGER NOT NULL DEFAULT 10,
  judging TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  settings TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE media (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  sensitive INTEGER NOT NULL DEFAULT 0,
  uploaded_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE questions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  type TEXT NOT NULL,          -- mc | tf | open | number | order | match | ranking
  scope TEXT NOT NULL DEFAULT 'team', -- team | individual
  scoring TEXT NOT NULL DEFAULT 'fixed', -- fixed | speed | closest
  prompt TEXT NOT NULL,
  quote TEXT,                  -- bv. app-bericht bij Bro Code
  context TEXT,
  options TEXT NOT NULL DEFAULT '[]', -- JSON array van strings (publiek)
  media_id TEXT REFERENCES media(id) ON DELETE SET NULL,
  points INTEGER NOT NULL DEFAULT 1,
  seconds INTEGER NOT NULL DEFAULT 30,
  allow_bet INTEGER NOT NULL DEFAULT 0,
  is_example INTEGER NOT NULL DEFAULT 0,
  voided_at INTEGER,
  voided_reason TEXT,
  settings TEXT NOT NULL DEFAULT '{}',
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Antwoordsleutel apart: wordt nooit samen met de vraag naar spelers/tv gestuurd.
CREATE TABLE answer_keys (
  question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  correct TEXT NOT NULL DEFAULT 'null', -- JSON: index | [indices] | number | [volgorde]
  accepted TEXT NOT NULL DEFAULT '[]',  -- JSON: toegestane varianten (open)
  explanation TEXT,
  tolerance REAL
);

-- Live toestand per event (één rij). Overleeft herstart van de server.
CREATE TABLE live_state (
  event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  screen TEXT NOT NULL DEFAULT 'lobby', -- lobby | round_intro | question | scoreboard | break | finale
  round_id TEXT,
  question_id TEXT,
  phase TEXT NOT NULL DEFAULT 'idle',   -- idle | ready | open | closed | revealed | scored
  paused INTEGER NOT NULL DEFAULT 0,
  open_at INTEGER,       -- ms, servertijd
  deadline INTEGER,      -- ms, servertijd
  paused_at INTEGER,     -- ms; bij hervatten schuiven open_at/deadline op
  seq INTEGER NOT NULL DEFAULT 0,       -- verhoogd bij elke overgang (voorkomt dubbele klik)
  message TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  owner_key TEXT NOT NULL,     -- 'p:<participantId>' of 't:<teamId>'
  participant_id TEXT REFERENCES participants(id) ON DELETE CASCADE,
  team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
  answer TEXT NOT NULL,        -- JSON
  bet INTEGER,
  received_at INTEGER NOT NULL,
  elapsed_ms INTEGER,
  verdict TEXT,                -- null | correct | wrong | partial
  judged_by TEXT,
  UNIQUE(question_id, owner_key)
);

CREATE TABLE score_events (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
  participant_id TEXT REFERENCES participants(id) ON DELETE CASCADE,
  board TEXT NOT NULL DEFAULT 'team',   -- team | individual
  question_id TEXT REFERENCES questions(id) ON DELETE SET NULL,
  source_key TEXT,              -- idempotentie: zelfde bron vervangt, telt nooit dubbel
  points INTEGER NOT NULL,
  reason TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'auto',   -- auto | manual | bonus | correction
  created_by TEXT,
  created_at INTEGER NOT NULL,
  voided_at INTEGER,
  voided_reason TEXT
);
CREATE UNIQUE INDEX score_source_active ON score_events(source_key) WHERE voided_at IS NULL AND source_key IS NOT NULL;

CREATE TABLE ranking_votes (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  voter_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  choice_id TEXT REFERENCES participants(id) ON DELETE CASCADE, -- null = overgeslagen
  created_at INTEGER NOT NULL,
  UNIQUE(question_id, voter_id)
);

CREATE TABLE shots (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL UNIQUE REFERENCES teams(id) ON DELETE CASCADE,
  number INTEGER,
  name TEXT, flavor TEXT, base TEXT, ingredients TEXT, allergens TEXT, story TEXT, amount TEXT,
  accepted_flavors TEXT NOT NULL DEFAULT '[]',
  accepted_bases TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);

CREATE TABLE missions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL DEFAULT 'closest', -- closest | check
  target TEXT,
  unit TEXT,
  max_points INTEGER NOT NULL DEFAULT 5,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  mission_id TEXT REFERENCES missions(id) ON DELETE CASCADE,
  question_id TEXT REFERENCES questions(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  value TEXT,
  note TEXT,
  media_id TEXT REFERENCES media(id) ON DELETE SET NULL,
  checked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(mission_id, team_id)
);

CREATE TABLE investments (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  from_team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  allocation TEXT NOT NULL,   -- JSON {teamId: bedrag}
  created_at INTEGER NOT NULL,
  UNIQUE(question_id, from_team_id)
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT,
  actor TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_q_round ON questions(round_id, sort);
CREATE INDEX idx_sub_q ON submissions(question_id);
CREATE INDEX idx_score_event ON score_events(event_id);
