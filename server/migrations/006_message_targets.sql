-- Berichten aan één of een paar spelers (null = iedereen).
ALTER TABLE messages ADD COLUMN to_ids TEXT;
