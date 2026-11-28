CREATE INDEX sync_image_render_output ON sync_entities (json_extract(payload_json, '$.outputAssetId'))
WHERE entity_type = 'image_render';

CREATE VIEW sync_image_dependencies AS
SELECT CASE
  WHEN EXISTS (
    SELECT 1 FROM sync_pending p
    JOIN sync_entities a ON a.entity_type = 'asset' AND a.entity_id = p.entity_id
    WHERE p.entity_type = 'asset' AND json_extract(a.payload_json, '$.sha256') IS NOT NULL AND (
      json_extract(p.payload_json, '$.sha256') IS NOT json_extract(a.payload_json, '$.sha256') OR
      json_extract(p.payload_json, '$.sourceKey') IS NOT json_extract(a.payload_json, '$.sourceKey') OR
      json_extract(p.payload_json, '$.kind') IS NOT json_extract(a.payload_json, '$.kind') OR
      json_extract(p.payload_json, '$.mimeType') IS NOT json_extract(a.payload_json, '$.mimeType') OR
      json_extract(p.payload_json, '$.bytes') IS NOT json_extract(a.payload_json, '$.bytes') OR
      json_extract(p.payload_json, '$.width') IS NOT json_extract(a.payload_json, '$.width') OR
      json_extract(p.payload_json, '$.height') IS NOT json_extract(a.payload_json, '$.height'))
      AND EXISTS (
        SELECT 1 FROM sync_entities r
        WHERE r.entity_type IN ('image_project', 'image_render') AND (
          json_extract(r.payload_json, '$.baseAssetId') = p.entity_id OR
          json_extract(r.payload_json, '$.outputAssetId') = p.entity_id OR
          EXISTS (SELECT 1 FROM json_each(r.payload_json, '$.assetIds') ref WHERE ref.value = p.entity_id)
        )
      )
  ) THEN 'image_asset_immutable'
  WHEN EXISTS (
    SELECT 1 FROM sync_pending p
    JOIN sync_entities e USING (entity_type, entity_id)
    WHERE p.entity_type = 'image_render' AND (p.deleted_at IS NOT NULL OR p.payload_json <> e.payload_json)
  ) THEN 'image_render_immutable'
  WHEN EXISTS (
    SELECT 1 FROM sync_pending p JOIN json_each(p.payload_json, '$.assetIds') ref
    WHERE p.entity_type IN ('image_project', 'image_render') AND p.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM sync_proposed a WHERE a.entity_type = 'asset' AND a.entity_id = ref.value
          AND json_extract(a.payload_json, '$.sha256') IS NOT NULL
          AND json_extract(a.payload_json, '$.width') > 0 AND json_extract(a.payload_json, '$.height') > 0
      )
  ) OR EXISTS (
    SELECT 1 FROM sync_pending p
    WHERE p.entity_type = 'image_project' AND p.deleted_at IS NULL AND NOT EXISTS (
      SELECT 1 FROM sync_proposed a WHERE a.entity_type = 'asset'
        AND a.entity_id = json_extract(p.payload_json, '$.baseAssetId')
        AND json_extract(a.payload_json, '$.sha256') IS NOT NULL
        AND json_extract(a.payload_json, '$.width') > 0 AND json_extract(a.payload_json, '$.height') > 0
    )
  ) OR EXISTS (
    SELECT 1 FROM sync_pending p
    WHERE p.entity_type = 'image_render' AND NOT EXISTS (
      SELECT 1 FROM sync_proposed a WHERE a.entity_type = 'asset'
        AND a.entity_id = json_extract(p.payload_json, '$.outputAssetId')
    )
  ) THEN 'asset_missing'
  WHEN EXISTS (
    SELECT 1 FROM sync_pending p
    WHERE p.entity_type = 'image_render' AND NOT EXISTS (
      SELECT 1 FROM sync_proposed project WHERE project.entity_type = 'image_project'
        AND project.entity_id = json_extract(p.payload_json, '$.projectId')
    )
  ) THEN 'image_project_missing'
  WHEN EXISTS (
    SELECT 1 FROM sync_pending p JOIN json_each(p.payload_json, '$.scene.layers') layer
    JOIN sync_proposed a ON a.entity_type = 'asset' AND a.entity_id = json_extract(layer.value, '$.assetId')
    WHERE p.entity_type IN ('image_project', 'image_render') AND p.deleted_at IS NULL AND (
      json_extract(layer.value, '$.crop.x') > json_extract(a.payload_json, '$.width') OR
      json_extract(layer.value, '$.crop.width') > json_extract(a.payload_json, '$.width') OR
      json_extract(layer.value, '$.crop.y') > json_extract(a.payload_json, '$.height') OR
      json_extract(layer.value, '$.crop.height') > json_extract(a.payload_json, '$.height') OR
      json_extract(layer.value, '$.crop.x') + json_extract(layer.value, '$.crop.width') > json_extract(a.payload_json, '$.width') + 0.001 OR
      json_extract(layer.value, '$.crop.y') + json_extract(layer.value, '$.crop.height') > json_extract(a.payload_json, '$.height') + 0.001)
  ) THEN 'invalid_image_crop'
  WHEN EXISTS (
    SELECT 1 FROM sync_pending p
    JOIN sync_proposed a ON a.entity_type = 'asset' AND a.entity_id = json_extract(p.payload_json, '$.outputAssetId')
    WHERE p.entity_type = 'image_render' AND (
      json_extract(a.payload_json, '$.sourceKey') IS NOT ('image-render:' || p.entity_id) OR
      json_extract(a.payload_json, '$.kind') IS NOT 'original' OR
      json_extract(a.payload_json, '$.width') IS NOT
        (json_extract(p.payload_json, '$.scene.artboard.width') * json_extract(p.payload_json, '$.exportOptions.scale')) OR
      json_extract(a.payload_json, '$.height') IS NOT
        (json_extract(p.payload_json, '$.scene.artboard.height') * json_extract(p.payload_json, '$.exportOptions.scale')) OR
      json_extract(a.payload_json, '$.mimeType') IS NOT ('image/' || json_extract(p.payload_json, '$.exportOptions.format')) OR
      json_extract(a.payload_json, '$.sha256') IS NULL
    )
  ) THEN 'image_render_output_mismatch'
END AS image_reason;
