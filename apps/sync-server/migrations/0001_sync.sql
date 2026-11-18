CREATE TABLE sync_identity (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  instance_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  claimed INTEGER NOT NULL DEFAULT 0 CHECK (claimed IN (0, 1)),
  claim_device TEXT,
  seed_status TEXT NOT NULL DEFAULT 'empty' CHECK (seed_status IN ('empty', 'seeding', 'ready')),
  seed_device TEXT,
  min_cursor INTEGER NOT NULL DEFAULT 0
) STRICT;

INSERT INTO sync_identity (id, instance_id, workspace_id, epoch)
VALUES (1, lower(hex(randomblob(16))), lower(hex(randomblob(16))), lower(hex(randomblob(16))));

CREATE TABLE sync_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;

CREATE TABLE sync_pairings (
  token_hash TEXT PRIMARY KEY,
  created_by TEXT NOT NULL REFERENCES sync_devices(id),
  expires_at INTEGER NOT NULL,
  redeemed_by TEXT
) STRICT;

CREATE TABLE sync_entities (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  deleted_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
) STRICT;

CREATE INDEX sync_category_parent ON sync_entities (json_extract(payload_json, '$.parentId'))
WHERE entity_type = 'category' AND deleted_at IS NULL;

CREATE INDEX sync_entry_category ON sync_entities (json_extract(payload_json, '$.categoryId'))
WHERE entity_type = 'entry';

CREATE TABLE sync_changes (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
  payload_json TEXT NOT NULL,
  deleted_at INTEGER,
  group_id TEXT NOT NULL,
  group_index INTEGER NOT NULL,
  group_size INTEGER NOT NULL,
  changed_at INTEGER NOT NULL
) STRICT;

CREATE TABLE sync_operations (
  epoch TEXT NOT NULL,
  device_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  group_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('applied', 'conflict', 'rejected')),
  reason TEXT,
  versions_json TEXT NOT NULL,
  cursor INTEGER,
  PRIMARY KEY (epoch, device_id, operation_id)
) STRICT;

CREATE TABLE sync_blobs (
  sha256 TEXT PRIMARY KEY,
  size_bytes INTEGER NOT NULL
) STRICT;

CREATE VIEW sync_watermarks AS
SELECT *, MAX(min_cursor, COALESCE((SELECT MAX(cursor) FROM sync_changes), 0)) AS head_cursor
FROM sync_identity;

-- Only populated during the shared apply transaction. Batches never expose candidate rows.
CREATE TABLE sync_pending (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  operation TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  deleted_at INTEGER,
  group_index INTEGER NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
) STRICT;

CREATE VIEW sync_proposed AS
SELECT entity_type, entity_id, payload_json, deleted_at FROM sync_pending
UNION ALL
SELECT e.entity_type, e.entity_id, e.payload_json, e.deleted_at FROM sync_entities e
WHERE NOT EXISTS (
  SELECT 1 FROM sync_pending p WHERE (p.entity_type, p.entity_id) = (e.entity_type, e.entity_id)
);

CREATE VIEW sync_validation AS
SELECT CASE
  WHEN EXISTS (
    SELECT 1 FROM sync_pending p
    LEFT JOIN sync_entities e ON (p.entity_type, p.entity_id) = (e.entity_type, e.entity_id)
    WHERE p.base_revision <> COALESCE(e.revision, 0)
      OR (p.operation = 'restore' AND e.deleted_at IS NULL)
      OR (p.operation = 'delete' AND (e.revision IS NULL OR e.deleted_at IS NOT NULL))
      OR (p.operation = 'upsert' AND e.deleted_at IS NOT NULL)
  ) THEN 'revision_conflict'
  WHEN EXISTS (
    SELECT 1 FROM sync_pending p
    JOIN sync_proposed c ON c.entity_type = 'category' AND c.entity_id <> p.entity_id AND c.deleted_at IS NULL
    WHERE p.entity_type = 'category' AND p.deleted_at IS NULL
      AND json_extract(c.payload_json, '$.parentId') IS json_extract(p.payload_json, '$.parentId')
      AND json_extract(c.payload_json, '$.name') = json_extract(p.payload_json, '$.name') COLLATE NOCASE
  ) THEN 'category_name_conflict'
  WHEN EXISTS (
    SELECT 1 FROM sync_pending p
    JOIN sync_entities e ON e.entity_type = 'category' AND e.deleted_at IS NULL
      AND json_extract(e.payload_json, '$.parentId') = p.entity_id
    WHERE p.entity_type = 'category'
      AND (p.deleted_at IS NOT NULL OR json_extract(p.payload_json, '$.parentId') IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM sync_pending c WHERE (c.entity_type, c.entity_id) = ('category', e.entity_id))
  ) OR EXISTS (
    SELECT 1 FROM sync_pending p
    JOIN sync_entities e ON e.entity_type = 'entry' AND json_extract(e.payload_json, '$.categoryId') = p.entity_id
    WHERE p.entity_type = 'category' AND p.deleted_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM sync_pending c WHERE (c.entity_type, c.entity_id) = ('entry', e.entity_id))
  ) THEN 'category_in_use'
  WHEN EXISTS (
    SELECT 1 FROM sync_pending p
    WHERE p.entity_type = 'category' AND p.deleted_at IS NULL
      AND json_extract(p.payload_json, '$.parentId') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM sync_proposed c
        WHERE c.entity_type = 'category' AND c.entity_id = json_extract(p.payload_json, '$.parentId')
          AND c.deleted_at IS NULL AND json_extract(c.payload_json, '$.parentId') IS NULL
      )
  ) OR EXISTS (
    SELECT 1 FROM sync_pending p
    WHERE p.entity_type = 'entry' AND json_extract(p.payload_json, '$.categoryId') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM sync_proposed c WHERE c.entity_type = 'category'
          AND c.entity_id = json_extract(p.payload_json, '$.categoryId') AND c.deleted_at IS NULL
      )
  ) THEN 'category_missing'
  WHEN EXISTS (
    SELECT 1 FROM sync_pending p
    WHERE p.entity_type = 'entry' AND json_extract(p.payload_json, '$.contentBlobHash') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM sync_blobs b WHERE b.sha256 = json_extract(p.payload_json, '$.contentBlobHash')
          AND b.size_bytes = json_extract(p.payload_json, '$.contentBlobSize')
      )
  ) THEN 'blob_missing'
END AS reason;
