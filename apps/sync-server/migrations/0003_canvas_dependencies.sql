CREATE INDEX sync_canvas_parent ON sync_entities (json_extract(payload_json, '$.collectionId'))
WHERE entity_type IN ('collection_node', 'collection_edge') AND deleted_at IS NULL;

CREATE INDEX sync_canvas_edge_source ON sync_entities (json_extract(payload_json, '$.sourceNodeId'))
WHERE entity_type='collection_edge' AND deleted_at IS NULL;

CREATE INDEX sync_canvas_edge_target ON sync_entities (json_extract(payload_json, '$.targetNodeId'))
WHERE entity_type='collection_edge' AND deleted_at IS NULL;

CREATE VIEW sync_canvas_dependencies AS
SELECT CASE
  WHEN EXISTS (
    SELECT 1 FROM sync_pending p JOIN sync_entities e USING(entity_type,entity_id)
    WHERE p.entity_type IN ('collection_node','collection_edge') AND p.deleted_at IS NULL
      AND json_extract(p.payload_json,'$.collectionId') IS NOT json_extract(e.payload_json,'$.collectionId')
  ) THEN 'canvas_parent_changed'
  WHEN EXISTS (
    SELECT 1 FROM sync_pending p JOIN sync_proposed child
      ON json_extract(child.payload_json,'$.collectionId') = p.entity_id
    WHERE p.entity_type='collection' AND p.deleted_at IS NOT NULL
      AND child.entity_type IN ('collection_node','collection_edge') AND child.deleted_at IS NULL
  ) OR EXISTS (
    SELECT 1 FROM sync_pending p JOIN sync_proposed edge
      ON json_extract(edge.payload_json,'$.sourceNodeId') = p.entity_id
      OR json_extract(edge.payload_json,'$.targetNodeId') = p.entity_id
    WHERE p.entity_type='collection_node' AND p.deleted_at IS NOT NULL
      AND edge.entity_type='collection_edge' AND edge.deleted_at IS NULL
  ) THEN 'canvas_in_use'
  WHEN EXISTS (
    SELECT 1 FROM sync_pending p
    WHERE p.entity_type IN ('collection_node','collection_edge') AND p.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM sync_proposed c WHERE c.entity_type='collection' AND c.deleted_at IS NULL
        AND c.entity_id=json_extract(p.payload_json,'$.collectionId'))
  ) THEN 'collection_missing'
  WHEN EXISTS (
    SELECT 1 FROM sync_pending p
    WHERE p.entity_type='collection_edge' AND p.deleted_at IS NULL
      AND (SELECT COUNT(*) FROM sync_proposed n WHERE n.entity_type='collection_node' AND n.deleted_at IS NULL
        AND json_extract(n.payload_json,'$.collectionId')=json_extract(p.payload_json,'$.collectionId')
        AND n.entity_id IN (json_extract(p.payload_json,'$.sourceNodeId'),json_extract(p.payload_json,'$.targetNodeId'))) <> 2
  ) THEN 'canvas_endpoint_missing'
  WHEN EXISTS (
    SELECT 1 FROM sync_pending p WHERE p.entity_type='collection_node' AND p.deleted_at IS NULL
      AND json_extract(p.payload_json,'$.kind')='entry' AND NOT EXISTS (
        SELECT 1 FROM sync_proposed e WHERE e.entity_type='entry' AND e.entity_id=json_extract(p.payload_json,'$.entryId'))
  ) THEN 'source_entry_missing'
  WHEN EXISTS (
    SELECT 1 FROM sync_pending p WHERE p.entity_type='collection_node' AND p.deleted_at IS NULL
      AND json_extract(p.payload_json,'$.assetId') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM sync_proposed a WHERE a.entity_type='asset' AND a.entity_id=json_extract(p.payload_json,'$.assetId'))
  ) OR EXISTS (
    SELECT 1 FROM sync_pending p JOIN json_each(p.payload_json,'$.assetIds') ref
    WHERE p.entity_type='collection_node' AND p.deleted_at IS NULL AND NOT EXISTS (
      SELECT 1 FROM sync_proposed a WHERE a.entity_type='asset' AND a.entity_id=ref.value)
  ) THEN 'asset_missing'
  WHEN EXISTS (
    SELECT 1 FROM sync_pending p WHERE p.entity_type='collection_node' AND p.deleted_at IS NULL
      AND json_extract(p.payload_json,'$.contentBlobHash') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM sync_blobs b WHERE b.sha256=json_extract(p.payload_json,'$.contentBlobHash')
          AND b.size_bytes=json_extract(p.payload_json,'$.contentBlobSize'))
  ) THEN 'blob_missing'
END AS canvas_reason;
