CREATE TABLE image_projects (
 id TEXT PRIMARY KEY, origin_entry_id TEXT NOT NULL, base_asset_id TEXT NOT NULL,
 scene_json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
) STRICT;
CREATE INDEX image_projects_input ON image_projects(origin_entry_id,base_asset_id);
CREATE TABLE image_editor_state (origin_entry_id TEXT NOT NULL,base_asset_id TEXT NOT NULL,project_id TEXT NOT NULL, PRIMARY KEY(origin_entry_id,base_asset_id)) STRICT;
CREATE TABLE image_project_assets (
 project_id TEXT NOT NULL REFERENCES image_projects(id) ON DELETE CASCADE,
 asset_id TEXT NOT NULL REFERENCES assets(id), PRIMARY KEY(project_id,asset_id)
) STRICT;
CREATE TABLE image_renders (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, scene_json TEXT NOT NULL,
 scene_hash TEXT NOT NULL, output_asset_id TEXT NOT NULL UNIQUE REFERENCES assets(id),
 asset_ids_json TEXT NOT NULL, export_options_json TEXT NOT NULL,
 renderer_version TEXT NOT NULL, created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE image_render_staging (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, project_version INTEGER NOT NULL,
 scene_json TEXT NOT NULL, scene_hash TEXT NOT NULL, asset_ids_json TEXT NOT NULL,
 export_options_json TEXT NOT NULL, output_asset_id TEXT NOT NULL UNIQUE,
 sha256 TEXT NOT NULL, relative_path TEXT NOT NULL, mime_type TEXT NOT NULL,
 bytes INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
 created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE image_render_receipts (
 id TEXT PRIMARY KEY REFERENCES image_renders(id), request_json TEXT NOT NULL,
 result_json TEXT NOT NULL
) STRICT;
CREATE TRIGGER sync_capture_image_projects_insert AFTER INSERT ON image_projects
WHEN (SELECT capture FROM sync_progress WHERE id=1)=1
BEGIN
 INSERT INTO sync_dirty(entity_type,entity_id,generation,batch_id)
 SELECT 'image_project',NEW.id,1,active_batch FROM sync_progress WHERE id=1
 ON CONFLICT(entity_type,entity_id) DO UPDATE SET generation=sync_dirty.generation+1,batch_id=COALESCE(excluded.batch_id,sync_dirty.batch_id);
END;
CREATE TRIGGER sync_capture_image_projects_update AFTER UPDATE ON image_projects
WHEN (SELECT capture FROM sync_progress WHERE id=1)=1
BEGIN
 INSERT INTO sync_dirty(entity_type,entity_id,generation,batch_id)
 SELECT 'image_project',NEW.id,1,active_batch FROM sync_progress WHERE id=1
 ON CONFLICT(entity_type,entity_id) DO UPDATE SET generation=sync_dirty.generation+1,batch_id=COALESCE(excluded.batch_id,sync_dirty.batch_id);
END;
CREATE TRIGGER sync_capture_image_renders_insert AFTER INSERT ON image_renders
WHEN (SELECT capture FROM sync_progress WHERE id=1)=1
BEGIN
 INSERT INTO sync_dirty(entity_type,entity_id,generation,batch_id)
 SELECT 'image_render',NEW.id,1,active_batch FROM sync_progress WHERE id=1
 ON CONFLICT(entity_type,entity_id) DO UPDATE SET generation=sync_dirty.generation+1,batch_id=COALESCE(excluded.batch_id,sync_dirty.batch_id);
END;
