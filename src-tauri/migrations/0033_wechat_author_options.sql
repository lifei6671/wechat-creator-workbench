CREATE TABLE wechat_author_entries (
    entry_id TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
    author TEXT NOT NULL CHECK(author <> '')
) STRICT;
CREATE INDEX wechat_author_entries_author ON wechat_author_entries(author);
CREATE TABLE wechat_author_options (
    author TEXT PRIMARY KEY NOT NULL
) STRICT;

CREATE TRIGGER wechat_author_option_insert AFTER INSERT ON wechat_author_entries
BEGIN
    INSERT OR IGNORE INTO wechat_author_options(author) VALUES(NEW.author);
END;
CREATE TRIGGER wechat_author_option_delete AFTER DELETE ON wechat_author_entries
BEGIN
    DELETE FROM wechat_author_options WHERE author=OLD.author
        AND NOT EXISTS(SELECT 1 FROM wechat_author_entries WHERE author=OLD.author);
END;

INSERT INTO wechat_author_entries(entry_id,author)
SELECT e.id,trim(COALESCE(e.source_details->>'$.author',s.author,''))
FROM entries e JOIN sources s ON s.id=e.source_id
WHERE e.kind='article' AND e.status='published' AND e.deleted_at IS NULL AND e.purged_at IS NULL
    AND trim(COALESCE(e.source_details->>'$.author',s.author,''))<>'';

CREATE TRIGGER wechat_author_entry_insert AFTER INSERT ON entries
WHEN NEW.kind='article' AND NEW.status='published' AND NEW.deleted_at IS NULL AND NEW.purged_at IS NULL
BEGIN
    INSERT INTO wechat_author_entries(entry_id,author)
    SELECT NEW.id,trim(COALESCE(NEW.source_details->>'$.author',s.author,''))
    FROM sources s WHERE s.id=NEW.source_id AND trim(COALESCE(NEW.source_details->>'$.author',s.author,''))<>'';
END;

CREATE TRIGGER wechat_author_entry_update
AFTER UPDATE OF kind,status,source_id,source_details,deleted_at,purged_at ON entries
WHEN OLD.kind IS NOT NEW.kind OR OLD.status IS NOT NEW.status OR OLD.source_id IS NOT NEW.source_id
    OR OLD.source_details IS NOT NEW.source_details OR OLD.deleted_at IS NOT NEW.deleted_at OR OLD.purged_at IS NOT NEW.purged_at
BEGIN
    DELETE FROM wechat_author_entries WHERE entry_id=NEW.id;
    INSERT INTO wechat_author_entries(entry_id,author)
    SELECT NEW.id,trim(COALESCE(NEW.source_details->>'$.author',s.author,''))
    FROM sources s WHERE s.id=NEW.source_id AND NEW.kind='article' AND NEW.status='published'
        AND NEW.deleted_at IS NULL AND NEW.purged_at IS NULL
        AND trim(COALESCE(NEW.source_details->>'$.author',s.author,''))<>'';
END;

CREATE TRIGGER wechat_author_source_update AFTER UPDATE OF author ON sources
WHEN OLD.author IS NOT NEW.author
BEGIN
    DELETE FROM wechat_author_entries WHERE entry_id IN (
        SELECT id FROM entries WHERE source_id=NEW.id AND source_details->>'$.author' IS NULL
    );
    INSERT INTO wechat_author_entries(entry_id,author)
    SELECT id,trim(NEW.author) FROM entries WHERE source_id=NEW.id AND source_details->>'$.author' IS NULL
        AND kind='article' AND status='published' AND deleted_at IS NULL AND purged_at IS NULL AND trim(NEW.author)<>'';
END;
