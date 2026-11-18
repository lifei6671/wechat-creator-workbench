CREATE INDEX collection_edges_by_source ON collection_edges(source_node_id);
CREATE INDEX collection_edges_by_target ON collection_edges(target_node_id);

-- Enroll existing canvases when upgrading an initialized workspace.
INSERT INTO sync_dirty (entity_type,entity_id,generation)
SELECT entity_type,entity_id,1 FROM (
    SELECT 'collection' AS entity_type,id AS entity_id FROM collections
    UNION ALL SELECT 'collection_node',id FROM collection_nodes
    UNION ALL SELECT 'collection_edge',id FROM collection_edges
) WHERE (SELECT capture FROM sync_progress WHERE id=1)=1;

CREATE TRIGGER sync_capture_collections_insert AFTER INSERT ON collections
WHEN (SELECT capture FROM sync_progress WHERE id=1)=1
BEGIN
    INSERT INTO sync_dirty (entity_type,entity_id,generation,batch_id)
    SELECT 'collection',NEW.id,1,active_batch FROM sync_progress WHERE id=1
    ON CONFLICT (entity_type,entity_id) DO UPDATE SET
        generation=sync_dirty.generation+1,
        batch_id=COALESCE(excluded.batch_id,sync_dirty.batch_id);
END;

CREATE TRIGGER sync_capture_collections_update AFTER UPDATE OF title,description ON collections
WHEN (SELECT capture FROM sync_progress WHERE id=1)=1
BEGIN
    INSERT INTO sync_dirty (entity_type,entity_id,generation,batch_id)
    SELECT 'collection',NEW.id,1,active_batch FROM sync_progress WHERE id=1
    ON CONFLICT (entity_type,entity_id) DO UPDATE SET
        generation=sync_dirty.generation+1,
        batch_id=COALESCE(excluded.batch_id,sync_dirty.batch_id);
END;

CREATE TRIGGER sync_capture_collections_delete AFTER DELETE ON collections
WHEN (SELECT capture FROM sync_progress WHERE id=1)=1
BEGIN
    INSERT INTO sync_dirty (entity_type,entity_id,generation,batch_id)
    SELECT 'collection',OLD.id,1,active_batch FROM sync_progress WHERE id=1
    ON CONFLICT (entity_type,entity_id) DO UPDATE SET
        generation=sync_dirty.generation+1,
        batch_id=COALESCE(excluded.batch_id,sync_dirty.batch_id);
END;

CREATE TRIGGER sync_capture_collection_nodes_insert AFTER INSERT ON collection_nodes
WHEN (SELECT capture FROM sync_progress WHERE id=1)=1
BEGIN
    INSERT INTO sync_dirty (entity_type,entity_id,generation,batch_id)
    SELECT 'collection_node',NEW.id,1,active_batch FROM sync_progress WHERE id=1
    ON CONFLICT (entity_type,entity_id) DO UPDATE SET
        generation=sync_dirty.generation+1,
        batch_id=COALESCE(excluded.batch_id,sync_dirty.batch_id);
END;

CREATE TRIGGER sync_capture_collection_nodes_update AFTER UPDATE ON collection_nodes
WHEN (SELECT capture FROM sync_progress WHERE id=1)=1
BEGIN
    INSERT INTO sync_dirty (entity_type,entity_id,generation,batch_id)
    SELECT 'collection_node',NEW.id,1,active_batch FROM sync_progress WHERE id=1
    ON CONFLICT (entity_type,entity_id) DO UPDATE SET
        generation=sync_dirty.generation+1,
        batch_id=COALESCE(excluded.batch_id,sync_dirty.batch_id);
END;

CREATE TRIGGER sync_capture_collection_nodes_delete AFTER DELETE ON collection_nodes
WHEN (SELECT capture FROM sync_progress WHERE id=1)=1
BEGIN
    INSERT INTO sync_dirty (entity_type,entity_id,generation,batch_id)
    SELECT 'collection_node',OLD.id,1,active_batch FROM sync_progress WHERE id=1
    ON CONFLICT (entity_type,entity_id) DO UPDATE SET
        generation=sync_dirty.generation+1,
        batch_id=COALESCE(excluded.batch_id,sync_dirty.batch_id);
END;

CREATE TRIGGER sync_capture_collection_edges_insert AFTER INSERT ON collection_edges
WHEN (SELECT capture FROM sync_progress WHERE id=1)=1
BEGIN
    INSERT INTO sync_dirty (entity_type,entity_id,generation,batch_id)
    SELECT 'collection_edge',NEW.id,1,active_batch FROM sync_progress WHERE id=1
    ON CONFLICT (entity_type,entity_id) DO UPDATE SET
        generation=sync_dirty.generation+1,
        batch_id=COALESCE(excluded.batch_id,sync_dirty.batch_id);
END;

CREATE TRIGGER sync_capture_collection_edges_update AFTER UPDATE ON collection_edges
WHEN (SELECT capture FROM sync_progress WHERE id=1)=1
BEGIN
    INSERT INTO sync_dirty (entity_type,entity_id,generation,batch_id)
    SELECT 'collection_edge',NEW.id,1,active_batch FROM sync_progress WHERE id=1
    ON CONFLICT (entity_type,entity_id) DO UPDATE SET
        generation=sync_dirty.generation+1,
        batch_id=COALESCE(excluded.batch_id,sync_dirty.batch_id);
END;

CREATE TRIGGER sync_capture_collection_edges_delete AFTER DELETE ON collection_edges
WHEN (SELECT capture FROM sync_progress WHERE id=1)=1
BEGIN
    INSERT INTO sync_dirty (entity_type,entity_id,generation,batch_id)
    SELECT 'collection_edge',OLD.id,1,active_batch FROM sync_progress WHERE id=1
    ON CONFLICT (entity_type,entity_id) DO UPDATE SET
        generation=sync_dirty.generation+1,
        batch_id=COALESCE(excluded.batch_id,sync_dirty.batch_id);
END;
