-- Fase 4: spelvormen
ALTER TABLE questions ADD COLUMN locked_at INTEGER;     -- gezet bij sluiten (shots: onthulling pas als alle shots dicht zijn)
ALTER TABLE shots ADD COLUMN updated_by TEXT;
ALTER TABLE evidence ADD COLUMN measured TEXT;          -- door de Douane gemeten/gecontroleerde waarde
ALTER TABLE evidence ADD COLUMN updated_by TEXT;
ALTER TABLE missions ADD COLUMN scored_at INTEGER;
CREATE INDEX idx_votes_q ON ranking_votes(question_id);
