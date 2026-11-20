ALTER TABLE entries ADD COLUMN purged_at INTEGER;
CREATE INDEX entries_trash_retention ON entries(deleted_at)
WHERE deleted_at IS NOT NULL AND purged_at IS NULL;
