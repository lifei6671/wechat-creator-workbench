DROP VIEW sync_article_dependencies;
CREATE VIEW sync_article_dependencies AS
SELECT CASE
  WHEN EXISTS (
    SELECT 1 FROM sync_pending p
    JOIN sync_proposed a ON a.entity_type = 'asset' AND a.entity_id <> p.entity_id
      AND json_extract(a.payload_json, '$.kind') = 'derived'
      AND json_extract(a.payload_json, '$.sourceKey') = json_extract(p.payload_json, '$.sourceKey')
      AND json_extract(a.payload_json, '$.sha256') = json_extract(p.payload_json, '$.sha256')
    WHERE p.entity_type = 'asset' AND json_extract(p.payload_json, '$.kind') = 'derived'
  ) THEN 'derived_asset_conflict'
  WHEN EXISTS (
    SELECT 1 FROM sync_pending p
    WHERE p.entity_type = 'asset' AND json_extract(p.payload_json, '$.sha256') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM sync_blobs b WHERE b.sha256 = json_extract(p.payload_json, '$.sha256')
          AND b.size_bytes = json_extract(p.payload_json, '$.bytes')
      )
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
