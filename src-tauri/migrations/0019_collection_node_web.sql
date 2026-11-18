ALTER TABLE collection_edges RENAME TO collection_edges_previous;
ALTER TABLE collection_nodes RENAME TO collection_nodes_previous;

CREATE TABLE collection_nodes (
    id TEXT PRIMARY KEY NOT NULL,
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('entry', 'image', 'text', 'web')),
    entry_id TEXT REFERENCES entries(id),
    asset_id TEXT REFERENCES assets(id),
    content_md TEXT NOT NULL DEFAULT '',
    x REAL NOT NULL DEFAULT 0,
    y REAL NOT NULL DEFAULT 0,
    width REAL NOT NULL DEFAULT 320,
    height REAL NOT NULL DEFAULT 200,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    color TEXT CHECK (color IN ('red', 'orange', 'amber', 'green', 'blue', 'violet')),
    custom_color TEXT CHECK (
        length(custom_color) = 7
        AND substr(custom_color, 1, 1) = '#'
        AND substr(custom_color, 2) NOT GLOB '*[^0-9A-Fa-f]*'
    ),
    external_url TEXT CHECK (length(external_url) > 0),
    CHECK ((kind = 'web') = (external_url IS NOT NULL)),
    CHECK (
        (kind = 'entry' AND entry_id IS NOT NULL AND asset_id IS NULL AND content_md = '')
        OR (kind = 'image' AND entry_id IS NULL AND asset_id IS NOT NULL AND content_md = '')
        OR (kind = 'text' AND entry_id IS NULL AND asset_id IS NULL)
        OR (kind = 'web' AND entry_id IS NULL AND asset_id IS NULL AND content_md = '')
    )
) STRICT;

INSERT INTO collection_nodes (
    id, collection_id, kind, entry_id, asset_id, content_md,
    x, y, width, height, created_at, updated_at, color, custom_color
)
SELECT id, collection_id, kind, entry_id, asset_id, content_md,
       x, y, width, height, created_at, updated_at, color, custom_color
FROM collection_nodes_previous;

CREATE TABLE collection_edges (
    id TEXT PRIMARY KEY NOT NULL,
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    source_node_id TEXT NOT NULL REFERENCES collection_nodes(id) ON DELETE CASCADE,
    target_node_id TEXT NOT NULL REFERENCES collection_nodes(id) ON DELETE CASCADE,
    label TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    CHECK (source_node_id <> target_node_id)
) STRICT;

INSERT INTO collection_edges (id, collection_id, source_node_id, target_node_id, label, created_at)
SELECT id, collection_id, source_node_id, target_node_id, label, created_at
FROM collection_edges_previous;

DROP TABLE collection_edges_previous;
DROP TABLE collection_nodes_previous;

CREATE INDEX collection_nodes_by_collection ON collection_nodes(collection_id, id);
CREATE INDEX collection_nodes_by_entry ON collection_nodes(entry_id) WHERE entry_id IS NOT NULL;
CREATE INDEX collection_nodes_by_asset ON collection_nodes(asset_id) WHERE asset_id IS NOT NULL;
CREATE INDEX collection_edges_by_collection ON collection_edges(collection_id);
