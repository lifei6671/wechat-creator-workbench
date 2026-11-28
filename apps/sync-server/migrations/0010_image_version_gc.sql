CREATE TABLE image_gc_state (
 id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0
) STRICT;
INSERT INTO image_gc_state VALUES(1,0);

CREATE TABLE image_gc_copies (
 id TEXT PRIMARY KEY,
 backend TEXT NOT NULL CHECK(backend IN ('private','s3')),
 scope TEXT NOT NULL, object_key TEXT NOT NULL, generation TEXT NOT NULL,
 source_sha256 TEXT NOT NULL, content_sha256 TEXT NOT NULL,
 size_bytes INTEGER NOT NULL CHECK(size_bytes>=0),
 managed INTEGER NOT NULL DEFAULT 0 CHECK(managed IN (0,1)),
 state TEXT NOT NULL CHECK(state IN ('uploading','live','waiting','deleting','retired','restoring','expired','unknown')),
 created_at INTEGER NOT NULL, due_at INTEGER, created_epoch TEXT NOT NULL DEFAULT '',
 UNIQUE(scope,object_key)
) STRICT;
CREATE INDEX image_gc_copy_hash ON image_gc_copies(source_sha256,state);
CREATE TABLE image_gc_private_heads (
 sha256 TEXT PRIMARY KEY, copy_id TEXT NOT NULL REFERENCES image_gc_copies(id)
) STRICT;
INSERT INTO image_gc_copies(id,backend,scope,object_key,generation,source_sha256,content_sha256,size_bytes,managed,state,created_at,due_at)
 SELECT 'legacy-'||sha256,'private','private:'||instance_id||':'||workspace_id,sha256,'legacy',
 sha256,sha256,size_bytes,0,'live',0,NULL FROM sync_blobs CROSS JOIN sync_identity;
INSERT INTO image_gc_private_heads SELECT sha256,'legacy-'||sha256 FROM sync_blobs;

CREATE TABLE image_gc_protections (
 sha256 TEXT NOT NULL, reason TEXT NOT NULL, owner TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(sha256,reason,owner)
) STRICT;
CREATE TABLE image_gc_rounds (
 id TEXT PRIMARY KEY, revision INTEGER NOT NULL, cursor INTEGER NOT NULL,
 candidates_json TEXT NOT NULL, created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE image_gc_checkpoints (
 device_id TEXT PRIMARY KEY REFERENCES sync_devices(id),
 round_id TEXT NOT NULL REFERENCES image_gc_rounds(id),
 revision INTEGER NOT NULL, cursor INTEGER NOT NULL, capability INTEGER NOT NULL,
 roots_json TEXT NOT NULL, created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE image_gc_jobs (
 id TEXT PRIMARY KEY, copy_id TEXT NOT NULL REFERENCES image_gc_copies(id),
 generation TEXT NOT NULL, round_id TEXT NOT NULL REFERENCES image_gc_rounds(id),
 executor TEXT NOT NULL REFERENCES sync_devices(id),
 state TEXT NOT NULL CHECK(state IN ('claimed','backing_up','deleting','retired','restoring','restored','expiring','expired','failed','unknown')),
 restored_copy_id TEXT REFERENCES image_gc_copies(id),
 backup_key TEXT, backup_verified INTEGER NOT NULL DEFAULT 0 CHECK(backup_verified IN (0,1)),
 created_at INTEGER NOT NULL, removed_at INTEGER, expires_at INTEGER, error TEXT,
 UNIQUE(copy_id,generation)
) STRICT;

CREATE TRIGGER image_gc_entity_insert AFTER INSERT ON sync_entities BEGIN
 UPDATE image_gc_state SET revision=revision+1;
END;
CREATE TRIGGER image_gc_entity_update AFTER UPDATE ON sync_entities BEGIN
 UPDATE image_gc_state SET revision=revision+1;
END;
CREATE TRIGGER image_gc_entity_delete AFTER DELETE ON sync_entities BEGIN
 UPDATE image_gc_state SET revision=revision+1;
END;
CREATE TRIGGER image_gc_device_insert AFTER INSERT ON sync_devices BEGIN
 UPDATE image_gc_state SET revision=revision+1;
END;
CREATE TRIGGER image_gc_device_update AFTER UPDATE OF revoked_at,token_hash ON sync_devices BEGIN
 UPDATE image_gc_state SET revision=revision+1;
END;
CREATE TRIGGER image_gc_protection_insert AFTER INSERT ON image_gc_protections BEGIN
 UPDATE image_gc_state SET revision=revision+1;
 UPDATE image_gc_copies SET state='live',due_at=NULL WHERE source_sha256=NEW.sha256 AND state='waiting';
END;
CREATE TRIGGER image_gc_copy_insert AFTER INSERT ON image_gc_copies BEGIN
 UPDATE image_gc_state SET revision=revision+1;
END;

CREATE VIEW image_gc_render_assets AS
 SELECT r.entity_id AS render_id,r.payload_json->>'$.projectId' AS project_id,
 r.payload_json->>'$.outputAssetId' AS asset_id,r.payload_json->>'$.createdAt' AS created_at,
 r.payload_json->'$.assetIds' AS inputs_json,a.payload_json->>'$.sha256' AS sha256,
 row_number() OVER(PARTITION BY r.payload_json->>'$.projectId'
 ORDER BY r.payload_json->>'$.createdAt' DESC,r.entity_id DESC) AS rank
 FROM sync_entities r JOIN sync_entities a
 ON a.entity_type='asset' AND a.entity_id=r.payload_json->>'$.outputAssetId'
 WHERE r.entity_type='image_render' AND a.payload_json->>'$.sourceKey'='image-render:'||r.entity_id;

CREATE VIEW image_gc_live_hashes AS
 WITH RECURSIVE anchors(id) AS (
  SELECT a.entity_id FROM sync_entities a WHERE a.entity_type='asset' AND (
   COALESCE(a.payload_json->>'$.retainOnExit',0)=1
   OR EXISTS(SELECT 1 FROM image_gc_protections pin WHERE pin.sha256=a.payload_json->>'$.sha256')
   OR EXISTS(SELECT 1 FROM image_gc_copies c WHERE c.source_sha256=a.payload_json->>'$.sha256' AND c.state IN ('uploading','restoring'))
   OR NOT EXISTS(SELECT 1 FROM image_gc_render_assets r WHERE r.asset_id=a.entity_id))
  UNION SELECT asset_id FROM image_gc_render_assets WHERE rank<=5
   OR created_at>CAST(unixepoch('subsec')*1000 AS INTEGER)-2592000000
  UNION SELECT ref.value FROM sync_entities e,json_each(e.payload_json,'$.assetIds') ref
   WHERE e.entity_type IN ('entry','collection_node','image_project')
  UNION SELECT e.payload_json->>'$.coverAssetId' FROM sync_entities e WHERE e.entity_type='entry'
  UNION SELECT e.payload_json->>'$.assetId' FROM sync_entities e WHERE e.entity_type='collection_node'
 ), roots(id) AS (
  SELECT id FROM anchors
  UNION SELECT e.payload_json->>'$.baseAssetId' FROM sync_entities e WHERE e.entity_type='image_project'
  UNION SELECT ref.value FROM image_gc_render_assets r JOIN roots u ON u.id=r.asset_id,json_each(r.inputs_json) ref
  UNION SELECT a.entity_id FROM sync_entities a JOIN sync_entities b
   ON a.entity_type='asset' AND b.entity_type='asset' AND a.payload_json->>'$.sha256'=b.payload_json->>'$.sha256'
   JOIN roots u ON u.id=b.entity_id
 )
 SELECT a.payload_json->>'$.sha256' AS sha256 FROM roots u JOIN sync_entities a
 ON a.entity_type='asset' AND a.entity_id=u.id WHERE a.payload_json->>'$.sha256' IS NOT NULL
 UNION SELECT sha256 FROM image_gc_protections
 UNION SELECT e.payload_json->>'$.contentBlobHash' FROM sync_entities e
 WHERE e.payload_json->>'$.contentBlobHash' IS NOT NULL
 UNION SELECT source_sha256 FROM image_gc_copies WHERE state IN ('uploading','restoring');

-- Recovery protects copies, not the original locations awaiting removal.
CREATE VIEW image_gc_recovery_hashes AS
 WITH RECURSIVE origins(copy_id,sha256) AS (
  SELECT c.id,c.source_sha256 FROM image_gc_copies c LEFT JOIN image_gc_jobs j
   ON j.copy_id=c.id AND j.generation=c.generation
  WHERE c.managed=1 AND (c.state IN ('live','uploading','waiting','deleting','restoring','unknown')
   OR (c.state='retired' AND j.backup_verified=1 AND (j.state='restoring' OR j.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER))))
 ), inputs(origin_copy_id,asset_id) AS (
  SELECT o.copy_id,a.entity_id FROM origins o JOIN sync_entities a
   ON a.entity_type='asset' AND a.payload_json->>'$.sha256'=o.sha256
  UNION SELECT i.origin_copy_id,ref.value FROM inputs i JOIN image_gc_render_assets r
   ON r.asset_id=i.asset_id,json_each(r.inputs_json) ref
 )
 SELECT DISTINCT i.origin_copy_id,a.payload_json->>'$.sha256' AS sha256
 FROM inputs i JOIN sync_entities a ON a.entity_type='asset' AND a.entity_id=i.asset_id
 WHERE a.payload_json->>'$.sha256' IS NOT NULL;

CREATE TRIGGER image_gc_publish_old BEFORE UPDATE ON sync_entities
 WHEN OLD.entity_type='entry' AND OLD.payload_json->>'$.status'='published' BEGIN
 INSERT OR IGNORE INTO image_gc_protections
 SELECT a.payload_json->>'$.sha256','published',OLD.entity_id,CAST(unixepoch('subsec')*1000 AS INTEGER)
 FROM sync_entities a WHERE a.entity_type='asset' AND a.payload_json->>'$.sha256' IS NOT NULL AND
 (a.entity_id=OLD.payload_json->>'$.coverAssetId' OR a.entity_id IN (SELECT value FROM json_each(OLD.payload_json,'$.assetIds')));
END;
CREATE TRIGGER image_gc_publish_new AFTER INSERT ON sync_entities
 WHEN NEW.entity_type='entry' AND NEW.payload_json->>'$.status'='published' BEGIN
 INSERT OR IGNORE INTO image_gc_protections
 SELECT a.payload_json->>'$.sha256','published',NEW.entity_id,CAST(unixepoch('subsec')*1000 AS INTEGER)
 FROM sync_entities a WHERE a.entity_type='asset' AND a.payload_json->>'$.sha256' IS NOT NULL AND
 (a.entity_id=NEW.payload_json->>'$.coverAssetId' OR a.entity_id IN (SELECT value FROM json_each(NEW.payload_json,'$.assetIds')));
END;
CREATE TRIGGER image_gc_publish_update AFTER UPDATE ON sync_entities
 WHEN NEW.entity_type='entry' AND NEW.payload_json->>'$.status'='published' BEGIN
 INSERT OR IGNORE INTO image_gc_protections
 SELECT a.payload_json->>'$.sha256','published',NEW.entity_id,CAST(unixepoch('subsec')*1000 AS INTEGER)
 FROM sync_entities a WHERE a.entity_type='asset' AND a.payload_json->>'$.sha256' IS NOT NULL AND
 (a.entity_id=NEW.payload_json->>'$.coverAssetId' OR a.entity_id IN (SELECT value FROM json_each(NEW.payload_json,'$.assetIds')));
END;
INSERT OR IGNORE INTO image_gc_protections
 SELECT a.payload_json->>'$.sha256','published',e.entity_id,CAST(unixepoch('subsec')*1000 AS INTEGER)
 FROM sync_entities e JOIN sync_entities a ON a.entity_type='asset'
 WHERE e.entity_type='entry' AND e.payload_json->>'$.status'='published'
 AND a.payload_json->>'$.sha256' IS NOT NULL AND (a.entity_id=e.payload_json->>'$.coverAssetId'
 OR a.entity_id IN(SELECT value FROM json_each(e.payload_json,'$.assetIds')));

-- Evaluated against pending references in the same transaction that commits them.
CREATE VIEW sync_image_gc_dependencies AS
 WITH RECURSIVE refs(id) AS (
  SELECT ref.value FROM sync_pending p,json_each(p.payload_json,'$.assetIds') ref
   WHERE p.entity_type IN ('entry','collection_node','image_project') AND p.deleted_at IS NULL
  UNION SELECT p.payload_json->>'$.coverAssetId' FROM sync_pending p WHERE p.entity_type='entry' AND p.deleted_at IS NULL
  UNION SELECT p.payload_json->>'$.assetId' FROM sync_pending p WHERE p.entity_type='collection_node' AND p.deleted_at IS NULL
  UNION SELECT p.payload_json->>'$.baseAssetId' FROM sync_pending p WHERE p.entity_type='image_project' AND p.deleted_at IS NULL
  UNION SELECT p.entity_id FROM sync_pending p WHERE p.entity_type='asset' AND p.payload_json->>'$.retainOnExit'=1
 ), roots(id) AS (
  SELECT id FROM refs
  UNION SELECT ref.value FROM roots u JOIN sync_proposed r
   ON r.entity_type='image_render' AND r.payload_json->>'$.outputAssetId'=u.id,json_each(r.payload_json,'$.assetIds') ref
 )
 SELECT CASE WHEN EXISTS(SELECT 1 FROM roots r JOIN sync_proposed a
 ON a.entity_type='asset' AND a.entity_id=r.id JOIN image_gc_copies c ON c.source_sha256=a.payload_json->>'$.sha256'
 WHERE c.state NOT IN ('live','waiting') AND ((c.backend='private' AND EXISTS(SELECT 1 FROM image_gc_private_heads h WHERE h.copy_id=c.id)) OR (c.backend='s3' AND NOT EXISTS(SELECT 1 FROM image_gc_jobs j WHERE j.copy_id=c.id AND j.restored_copy_id IS NOT NULL)))) THEN 'gc_restore_required' END AS gc_reason;

CREATE TABLE image_gc_public_locations (
 copy_id TEXT PRIMARY KEY REFERENCES image_gc_copies(id), public_url TEXT NOT NULL,
 object_version TEXT
) STRICT;

CREATE TABLE image_gc_authorization(id INTEGER PRIMARY KEY CHECK(id=1),valid INTEGER NOT NULL CHECK(valid=1)) STRICT;

CREATE TABLE image_gc_imports(asset_id TEXT PRIMARY KEY,sha256 TEXT NOT NULL,source_key TEXT NOT NULL,size_bytes INTEGER NOT NULL) STRICT;

DROP VIEW sync_article_dependencies;
CREATE VIEW sync_article_dependencies AS
SELECT CASE
  WHEN EXISTS (
    SELECT 1 FROM sync_pending p
    WHERE p.entity_type = 'asset' AND json_extract(p.payload_json, '$.kind') = 'derived'
      AND EXISTS (
        SELECT 1 FROM sync_proposed a
        WHERE a.entity_type = 'asset' AND a.entity_id <> p.entity_id
          AND json_extract(a.payload_json, '$.kind') = 'derived'
          AND json_extract(a.payload_json, '$.sourceKey') = json_extract(p.payload_json, '$.sourceKey')
          AND json_extract(a.payload_json, '$.sha256') = json_extract(p.payload_json, '$.sha256')
      )
  ) THEN 'derived_asset_conflict'
  WHEN EXISTS (
    SELECT 1 FROM sync_pending p
    WHERE p.entity_type = 'asset' AND json_extract(p.payload_json, '$.sha256') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM sync_blobs b WHERE b.sha256 = json_extract(p.payload_json, '$.sha256')
          AND b.size_bytes = json_extract(p.payload_json, '$.bytes')
      )
      AND NOT EXISTS(SELECT 1 FROM image_gc_imports i WHERE i.asset_id=p.entity_id AND i.sha256=p.payload_json->>'$.sha256' AND i.source_key=p.payload_json->>'$.sourceKey' AND i.size_bytes=p.payload_json->>'$.bytes')
  ) THEN 'blob_missing'
  WHEN EXISTS (
    SELECT 1 FROM sync_pending p
    JOIN json_each(p.payload_json, '$.assetIds') ref
    WHERE p.entity_type = 'entry' AND NOT EXISTS (
      SELECT 1 FROM sync_proposed a WHERE a.entity_type = 'asset' AND a.entity_id = ref.value
    )
  ) OR EXISTS (
    SELECT 1 FROM sync_pending p
    WHERE p.entity_type = 'entry' AND json_extract(p.payload_json, '$.coverAssetId') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM sync_proposed a WHERE a.entity_type = 'asset'
          AND a.entity_id = json_extract(p.payload_json, '$.coverAssetId')
      )
  ) THEN 'asset_missing'
  WHEN EXISTS (
    SELECT 1 FROM sync_pending p
    JOIN json_each(p.payload_json, '$.sourceEntryIds') ref
    WHERE p.entity_type = 'entry' AND NOT EXISTS (
      SELECT 1 FROM sync_proposed e WHERE e.entity_type = 'entry' AND e.entity_id = ref.value
    )
  ) THEN 'source_entry_missing'
END AS dependency_reason;
