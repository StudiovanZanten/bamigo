-- Teamadvies: teamgenoten tikken een advies aan, de captain beslist.
CREATE TABLE advice (
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  answer TEXT NOT NULL,
  verdict TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (question_id, participant_id)
);
CREATE INDEX idx_advice_team ON advice(team_id);
ALTER TABLE memberships ADD COLUMN captain_since INTEGER;
ALTER TABLE live_state ADD COLUMN banner TEXT;          -- korte melding voor tv/telefoon, bv. captain-wissel
