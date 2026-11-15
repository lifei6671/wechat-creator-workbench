ALTER TABLE assets ADD COLUMN retain_on_exit INTEGER NOT NULL DEFAULT 0 CHECK (retain_on_exit IN (0, 1));

UPDATE assets SET retain_on_exit = 1 WHERE kind = 'original' AND sha256 IS NOT NULL;
