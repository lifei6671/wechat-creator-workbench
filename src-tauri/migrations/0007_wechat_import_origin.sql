ALTER TABLE entries ADD COLUMN wechat_imported INTEGER NOT NULL DEFAULT 0 CHECK (wechat_imported IN (0, 1));

-- The importer creates a record and registers its canonical source with the same timestamp.
UPDATE entries
SET wechat_imported = 1
WHERE EXISTS (
    SELECT 1
    FROM wechat_sources w
    JOIN sources s ON s.source_url = w.url
    WHERE w.entry_id = entries.id AND s.imported_at = entries.created_at
);
