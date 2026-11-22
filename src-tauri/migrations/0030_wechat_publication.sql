ALTER TABLE entries ADD COLUMN wechat_publication TEXT NOT NULL DEFAULT 'null';

CREATE TABLE wechat_publication_defaults (
    id TEXT PRIMARY KEY CHECK(id='default'),
    config TEXT NOT NULL,
    version INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;

CREATE TRIGGER sync_capture_wechat_defaults_insert AFTER INSERT ON wechat_publication_defaults
WHEN (SELECT capture FROM sync_progress WHERE id=1)=1
BEGIN
    INSERT INTO sync_dirty(entity_type,entity_id,generation,batch_id)
    VALUES('wechat_publication_defaults',NEW.id,1,NULL)
    ON CONFLICT(entity_type,entity_id) DO UPDATE SET generation=sync_dirty.generation+1;
END;

CREATE TRIGGER sync_capture_wechat_defaults_update AFTER UPDATE ON wechat_publication_defaults
WHEN (SELECT capture FROM sync_progress WHERE id=1)=1
BEGIN
    INSERT INTO sync_dirty(entity_type,entity_id,generation,batch_id)
    VALUES('wechat_publication_defaults',NEW.id,1,NULL)
    ON CONFLICT(entity_type,entity_id) DO UPDATE SET generation=sync_dirty.generation+1;
END;
