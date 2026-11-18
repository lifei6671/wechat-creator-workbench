CREATE TABLE sync_progress (
    id INTEGER PRIMARY KEY CHECK (id=1),
    capture INTEGER NOT NULL DEFAULT 0,
    seeding INTEGER NOT NULL DEFAULT 0,
    initialized INTEGER NOT NULL DEFAULT 0,
    cursor INTEGER NOT NULL DEFAULT 0,
    bootstrap_cursor INTEGER,
    active_batch TEXT
) STRICT;
INSERT INTO sync_progress (id) VALUES (1);

CREATE TABLE sync_dirty (
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    batch_id TEXT,
    PRIMARY KEY (entity_type,entity_id)
) STRICT;

CREATE TABLE sync_revisions (
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    deleted INTEGER NOT NULL,
    PRIMARY KEY (entity_type,entity_id)
) STRICT;

CREATE TABLE sync_outbox (
    id INTEGER PRIMARY KEY CHECK (id=1),
    operation_json TEXT NOT NULL,
    generations_json TEXT NOT NULL
) STRICT;

CREATE TABLE sync_inbox (
    cursor INTEGER PRIMARY KEY,
    group_id TEXT NOT NULL,
    group_size INTEGER NOT NULL,
    payload_json TEXT NOT NULL
) STRICT;
CREATE INDEX sync_inbox_group ON sync_inbox(group_id,cursor);

CREATE TABLE sync_bootstrap (
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (entity_type,entity_id)
) STRICT;

CREATE TABLE sync_issues (
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    reason TEXT NOT NULL,
    remote_json TEXT,
    PRIMARY KEY (entity_type,entity_id)
) STRICT;

CREATE TRIGGER sync_capture_entries_insert AFTER INSERT ON entries
WHEN (SELECT capture FROM sync_progress WHERE id=1)=1
BEGIN
    INSERT INTO sync_dirty (entity_type,entity_id,generation,batch_id)
    SELECT 'entry',NEW.id,1,(SELECT active_batch FROM sync_progress) WHERE 1
    ON CONFLICT (entity_type,entity_id) DO UPDATE SET
        generation=sync_dirty.generation+1,
        batch_id=COALESCE(excluded.batch_id,sync_dirty.batch_id);
END;

CREATE TRIGGER sync_capture_entries_update AFTER UPDATE ON entries
WHEN (SELECT capture FROM sync_progress WHERE id=1)=1
BEGIN
    INSERT INTO sync_dirty (entity_type,entity_id,generation,batch_id)
    SELECT 'entry',NEW.id,1,(SELECT active_batch FROM sync_progress) WHERE 1
    ON CONFLICT (entity_type,entity_id) DO UPDATE SET
        generation=sync_dirty.generation+1,
        batch_id=COALESCE(excluded.batch_id,sync_dirty.batch_id);
END;

CREATE TRIGGER sync_capture_categories_insert AFTER INSERT ON categories
WHEN (SELECT capture FROM sync_progress WHERE id=1)=1
BEGIN
    INSERT INTO sync_dirty (entity_type,entity_id,generation,batch_id)
    SELECT 'category',NEW.id,1,(SELECT active_batch FROM sync_progress) WHERE 1
    ON CONFLICT (entity_type,entity_id) DO UPDATE SET
        generation=sync_dirty.generation+1,
        batch_id=COALESCE(excluded.batch_id,sync_dirty.batch_id);
END;

CREATE TRIGGER sync_capture_categories_update AFTER UPDATE ON categories
WHEN (SELECT capture FROM sync_progress WHERE id=1)=1
BEGIN
    INSERT INTO sync_dirty (entity_type,entity_id,generation,batch_id)
    SELECT 'category',NEW.id,1,(SELECT active_batch FROM sync_progress) WHERE 1
    ON CONFLICT (entity_type,entity_id) DO UPDATE SET
        generation=sync_dirty.generation+1,
        batch_id=COALESCE(excluded.batch_id,sync_dirty.batch_id);
END;

CREATE TRIGGER sync_capture_categories_delete AFTER DELETE ON categories
WHEN (SELECT capture FROM sync_progress WHERE id=1)=1
BEGIN
    INSERT INTO sync_dirty (entity_type,entity_id,generation,batch_id)
    SELECT 'category',OLD.id,1,(SELECT active_batch FROM sync_progress) WHERE 1
    ON CONFLICT (entity_type,entity_id) DO UPDATE SET
        generation=sync_dirty.generation+1,
        batch_id=COALESCE(excluded.batch_id,sync_dirty.batch_id);
END;

CREATE TRIGGER sync_capture_entry_tags_insert AFTER INSERT ON entry_tags
WHEN (SELECT capture FROM sync_progress WHERE id=1)=1
BEGIN
    INSERT INTO sync_dirty (entity_type,entity_id,generation,batch_id)
    SELECT 'entry',NEW.entry_id,1,(SELECT active_batch FROM sync_progress) WHERE 1
    ON CONFLICT (entity_type,entity_id) DO UPDATE SET
        generation=sync_dirty.generation+1,
        batch_id=COALESCE(excluded.batch_id,sync_dirty.batch_id);
END;

CREATE TRIGGER sync_capture_entry_tags_delete AFTER DELETE ON entry_tags
WHEN (SELECT capture FROM sync_progress WHERE id=1)=1
BEGIN
    INSERT INTO sync_dirty (entity_type,entity_id,generation,batch_id)
    SELECT 'entry',OLD.entry_id,1,(SELECT active_batch FROM sync_progress) WHERE 1
    ON CONFLICT (entity_type,entity_id) DO UPDATE SET
        generation=sync_dirty.generation+1,
        batch_id=COALESCE(excluded.batch_id,sync_dirty.batch_id);
END;

CREATE TRIGGER sync_capture_entry_links_insert AFTER INSERT ON entry_links
WHEN (SELECT capture FROM sync_progress WHERE id=1)=1
BEGIN
    INSERT INTO sync_dirty (entity_type,entity_id,generation,batch_id)
    SELECT 'entry',NEW.article_id,1,(SELECT active_batch FROM sync_progress) WHERE 1
    ON CONFLICT (entity_type,entity_id) DO UPDATE SET
        generation=sync_dirty.generation+1,
        batch_id=COALESCE(excluded.batch_id,sync_dirty.batch_id);
END;

CREATE TRIGGER sync_capture_entry_links_delete AFTER DELETE ON entry_links
WHEN (SELECT capture FROM sync_progress WHERE id=1)=1
BEGIN
    INSERT INTO sync_dirty (entity_type,entity_id,generation,batch_id)
    SELECT 'entry',OLD.article_id,1,(SELECT active_batch FROM sync_progress) WHERE 1
    ON CONFLICT (entity_type,entity_id) DO UPDATE SET
        generation=sync_dirty.generation+1,
        batch_id=COALESCE(excluded.batch_id,sync_dirty.batch_id);
END;

CREATE TRIGGER sync_capture_assets_insert AFTER INSERT ON assets
WHEN (SELECT capture FROM sync_progress WHERE id=1)=1
BEGIN
    INSERT INTO sync_dirty (entity_type,entity_id,generation,batch_id)
    SELECT 'asset',NEW.id,1,(SELECT active_batch FROM sync_progress) WHERE 1
    ON CONFLICT (entity_type,entity_id) DO UPDATE SET
        generation=sync_dirty.generation+1,
        batch_id=COALESCE(excluded.batch_id,sync_dirty.batch_id);
END;

CREATE TRIGGER sync_capture_assets_update AFTER UPDATE OF sha256,mime_type,kind,source_key,bytes,name,width,height,retain_on_exit ON assets
WHEN (SELECT capture FROM sync_progress WHERE id=1)=1
BEGIN
    INSERT INTO sync_dirty (entity_type,entity_id,generation,batch_id)
    SELECT 'asset',NEW.id,1,(SELECT active_batch FROM sync_progress) WHERE 1
    ON CONFLICT (entity_type,entity_id) DO UPDATE SET
        generation=sync_dirty.generation+1,
        batch_id=COALESCE(excluded.batch_id,sync_dirty.batch_id);
END;

CREATE TRIGGER sync_capture_sources_update AFTER UPDATE ON sources
WHEN (SELECT capture FROM sync_progress WHERE id=1)=1
BEGIN
    INSERT INTO sync_dirty (entity_type,entity_id,generation,batch_id)
    SELECT 'entry',e.id,1,(SELECT active_batch FROM sync_progress) FROM entries e WHERE e.source_id=NEW.id
    ON CONFLICT (entity_type,entity_id) DO UPDATE SET
        generation=sync_dirty.generation+1,
        batch_id=COALESCE(excluded.batch_id,sync_dirty.batch_id);
END;
