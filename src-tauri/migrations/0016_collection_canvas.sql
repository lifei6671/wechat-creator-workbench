CREATE TABLE collections (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    viewport_x REAL NOT NULL DEFAULT 0,
    viewport_y REAL NOT NULL DEFAULT 0,
    viewport_zoom REAL NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE collection_nodes (
    id TEXT PRIMARY KEY NOT NULL,
    collection_id TEXT NOT NULL
        REFERENCES collections(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('entry', 'image', 'text')),
    entry_id TEXT REFERENCES entries(id),
    asset_id TEXT REFERENCES assets(id),
    content_md TEXT NOT NULL DEFAULT '',
    x REAL NOT NULL DEFAULT 0,
    y REAL NOT NULL DEFAULT 0,
    width REAL NOT NULL DEFAULT 320,
    height REAL NOT NULL DEFAULT 200,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (
        (kind = 'entry' AND entry_id IS NOT NULL
            AND asset_id IS NULL AND content_md = '')
        OR
        (kind = 'image' AND entry_id IS NULL
            AND asset_id IS NOT NULL AND content_md = '')
        OR
        (kind = 'text' AND entry_id IS NULL
            AND asset_id IS NULL)
    )
) STRICT;
CREATE INDEX collection_nodes_by_collection
    ON collection_nodes(collection_id, id);
CREATE INDEX collection_nodes_by_entry
    ON collection_nodes(entry_id) WHERE entry_id IS NOT NULL;
CREATE INDEX collection_nodes_by_asset
    ON collection_nodes(asset_id) WHERE asset_id IS NOT NULL;

CREATE TABLE collection_edges (
    id TEXT PRIMARY KEY NOT NULL,
    collection_id TEXT NOT NULL
        REFERENCES collections(id) ON DELETE CASCADE,
    source_node_id TEXT NOT NULL
        REFERENCES collection_nodes(id) ON DELETE CASCADE,
    target_node_id TEXT NOT NULL
        REFERENCES collection_nodes(id) ON DELETE CASCADE,
    label TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    CHECK(source_node_id <> target_node_id)
) STRICT;
CREATE INDEX collection_edges_by_collection
    ON collection_edges(collection_id);
