CREATE TABLE image_version_protection (
 sha256 TEXT NOT NULL, reason TEXT NOT NULL, owner TEXT NOT NULL DEFAULT '',
 created_at INTEGER NOT NULL, PRIMARY KEY(sha256,reason,owner)
) STRICT;
INSERT INTO image_version_protection SELECT sha256,'legacy','',created_at FROM asset_public_protection;
CREATE TABLE image_version_cleanup (
 id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, relative_path TEXT NOT NULL,
 bytes INTEGER NOT NULL CHECK(bytes>=0),
 state TEXT NOT NULL CHECK(state IN ('waiting','copying','removed','restored','cancelled','expired','failed')),
 created_at INTEGER NOT NULL, due_at INTEGER NOT NULL,
 backup_path TEXT, removed_at INTEGER, expires_at INTEGER, error TEXT,
 paths_json TEXT NOT NULL DEFAULT '[]', attempts INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE UNIQUE INDEX image_cleanup_live_hash ON image_version_cleanup(sha256)
 WHERE state IN ('waiting','copying','removed','failed');
CREATE INDEX image_cleanup_due ON image_version_cleanup(state,due_at);

CREATE TRIGGER image_published_old BEFORE UPDATE ON entries WHEN OLD.status='published' BEGIN
 INSERT OR IGNORE INTO image_version_protection
 SELECT a.sha256,'published',OLD.id,CAST(unixepoch('subsec')*1000 AS INTEGER)
 FROM assets a WHERE a.sha256 IS NOT NULL AND (a.id=OLD.cover_asset_id OR a.id IN
 (SELECT asset_id FROM entry_assets WHERE entry_id=OLD.id));
END;
CREATE TRIGGER image_published_deleted BEFORE DELETE ON entries WHEN OLD.status='published' BEGIN
 INSERT OR IGNORE INTO image_version_protection
 SELECT a.sha256,'published',OLD.id,CAST(unixepoch('subsec')*1000 AS INTEGER)
 FROM assets a WHERE a.sha256 IS NOT NULL AND (a.id=OLD.cover_asset_id OR a.id IN
 (SELECT asset_id FROM entry_assets WHERE entry_id=OLD.id));
END;
CREATE TRIGGER image_published_link AFTER INSERT ON entry_assets
WHEN EXISTS(SELECT 1 FROM entries WHERE id=NEW.entry_id AND status='published') BEGIN
 INSERT OR IGNORE INTO image_version_protection
 SELECT sha256,'published',NEW.entry_id,CAST(unixepoch('subsec')*1000 AS INTEGER)
 FROM assets WHERE id=NEW.asset_id AND sha256 IS NOT NULL;
END;
CREATE TRIGGER image_published_cover AFTER UPDATE OF cover_asset_id,status ON entries WHEN NEW.status='published' BEGIN
 INSERT OR IGNORE INTO image_version_protection
 SELECT sha256,'published',NEW.id,CAST(unixepoch('subsec')*1000 AS INTEGER)
 FROM assets WHERE sha256 IS NOT NULL AND (id=NEW.cover_asset_id OR id IN
 (SELECT asset_id FROM entry_assets WHERE entry_id=NEW.id));
END;
INSERT OR IGNORE INTO image_version_protection
SELECT a.sha256,'published',e.id,CAST(unixepoch('subsec')*1000 AS INTEGER)
FROM entries e JOIN assets a ON a.id=e.cover_asset_id OR a.id IN
 (SELECT asset_id FROM entry_assets WHERE entry_id=e.id)
WHERE e.status='published' AND a.sha256 IS NOT NULL;

CREATE TABLE image_gc_remote (
 copy_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, state TEXT NOT NULL,
 instance_id TEXT NOT NULL, epoch TEXT NOT NULL, payload_json TEXT NOT NULL
) STRICT;
CREATE TABLE image_gc_barriers (
 sha256 TEXT PRIMARY KEY, instance_id TEXT NOT NULL, epoch TEXT NOT NULL,
 round_id TEXT NOT NULL, revision INTEGER NOT NULL, cursor INTEGER NOT NULL
) STRICT;

CREATE TABLE image_public_copies (
 id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, profile_id TEXT NOT NULL, scope TEXT NOT NULL,
 object_key TEXT NOT NULL, generation TEXT NOT NULL, content_sha256 TEXT NOT NULL,
 bytes INTEGER NOT NULL, public_url TEXT NOT NULL, object_version TEXT,
 state TEXT NOT NULL, remote INTEGER NOT NULL, due_at INTEGER, backup_path TEXT,
 expires_at INTEGER, job_id TEXT, error TEXT,
 UNIQUE(scope,object_key)
) STRICT;
DROP TRIGGER protect_public_asset_insert;
DROP TRIGGER protect_public_asset_update;
CREATE TRIGGER protect_public_asset_insert AFTER INSERT ON asset_locations
 WHEN NOT EXISTS(SELECT 1 FROM image_public_copies c WHERE c.sha256=NEW.sha256 AND c.profile_id=NEW.storage_profile_id AND c.object_key=NEW.object_key) BEGIN
 INSERT OR IGNORE INTO asset_public_protection VALUES(NEW.sha256,CAST(unixepoch('subsec')*1000 AS INTEGER)); END;
CREATE TRIGGER protect_public_asset_update AFTER UPDATE ON asset_locations
 WHEN NOT EXISTS(SELECT 1 FROM image_public_copies c WHERE c.sha256=NEW.sha256 AND c.profile_id=NEW.storage_profile_id AND c.object_key=NEW.object_key) BEGIN
 INSERT OR IGNORE INTO asset_public_protection VALUES(NEW.sha256,CAST(unixepoch('subsec')*1000 AS INTEGER)); END;
