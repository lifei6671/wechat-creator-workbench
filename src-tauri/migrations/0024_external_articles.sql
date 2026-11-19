ALTER TABLE entries ADD COLUMN external_imported INTEGER NOT NULL DEFAULT 0 CHECK (external_imported IN (0, 1));
ALTER TABLE entries ADD COLUMN custom_properties TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(custom_properties));

UPDATE entries SET external_imported = 1
WHERE kind = 'reference' AND EXISTS (
    SELECT 1 FROM sources s WHERE s.id = entries.source_id AND s.account_name = 'GitHub'
    AND s.source_url LIKE 'https://github.com/%' AND s.imported_at = entries.created_at
);
