CREATE TABLE app_settings (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
) STRICT;

CREATE TABLE categories (
    id TEXT PRIMARY KEY NOT NULL,
    parent_id TEXT REFERENCES categories(id),
    name TEXT NOT NULL,
    depth INTEGER NOT NULL CHECK (depth IN (1, 2)),
    sort_order INTEGER NOT NULL,
    CHECK ((depth = 1) = (parent_id IS NULL))
) STRICT;
CREATE UNIQUE INDEX categories_root_name ON categories(name COLLATE NOCASE) WHERE parent_id IS NULL;
CREATE UNIQUE INDEX categories_child_name ON categories(parent_id, name COLLATE NOCASE) WHERE parent_id IS NOT NULL;
CREATE TRIGGER categories_parent_insert BEFORE INSERT ON categories
WHEN new.depth = 2 AND (SELECT depth FROM categories WHERE id = new.parent_id) <> 1
BEGIN SELECT RAISE(ABORT, 'category parent must be a root'); END;

CREATE TABLE sources (
    id TEXT PRIMARY KEY NOT NULL,
    source_url TEXT NOT NULL UNIQUE,
    author TEXT NOT NULL,
    account_name TEXT NOT NULL,
    original_published_at INTEGER,
    imported_at INTEGER NOT NULL
) STRICT;

CREATE TABLE assets (
    id TEXT PRIMARY KEY NOT NULL,
    sha256 TEXT,
    mime_type TEXT,
    relative_path TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('original', 'derived')),
    source_key TEXT,
    bytes INTEGER,
    created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX assets_sha256 ON assets(sha256);
CREATE INDEX assets_source_key ON assets(source_key);

CREATE TABLE entries (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    content_md TEXT NOT NULL,
    status TEXT NOT NULL,
    category_id TEXT REFERENCES categories(id),
    source_id TEXT REFERENCES sources(id),
    summary TEXT NOT NULL DEFAULT '',
    cover_asset_id TEXT REFERENCES assets(id),
    theme_id TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    published_at INTEGER,
    published_url TEXT NOT NULL DEFAULT '',
    deleted_at INTEGER,
    CHECK ((kind = 'idea' AND status IN ('inbox','planned','used','archived'))
        OR (kind = 'reference' AND status IN ('unread','reviewed','used','archived'))
        OR (kind = 'article' AND status IN ('draft','ready','published','archived')))
) STRICT;
CREATE INDEX entries_feed ON entries(deleted_at IS NOT NULL, kind, updated_at DESC, id DESC);
CREATE INDEX entries_category ON entries(category_id);

CREATE TABLE tags (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    normalized TEXT NOT NULL UNIQUE
) STRICT;
CREATE TABLE entry_tags (
    entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL REFERENCES tags(id),
    PRIMARY KEY(entry_id, tag_id)
) STRICT;
CREATE INDEX entry_tags_tag ON entry_tags(tag_id, entry_id);

CREATE TABLE entry_links (
    article_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    source_entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    PRIMARY KEY(article_id, source_entry_id)
) STRICT;
CREATE INDEX entry_links_source ON entry_links(source_entry_id, article_id);

CREATE TABLE entry_assets (
    entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    asset_id TEXT NOT NULL REFERENCES assets(id),
    PRIMARY KEY(entry_id, asset_id)
) STRICT;

CREATE TABLE entry_revisions (
    entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    content_md TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('manual','before_ai_replace')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY(entry_id, version)
) STRICT;

CREATE TABLE storage_profiles (
    id TEXT PRIMARY KEY NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN ('images','backup')),
    endpoint TEXT NOT NULL,
    region TEXT NOT NULL,
    bucket TEXT NOT NULL,
    object_prefix TEXT NOT NULL,
    public_base_url TEXT,
    credential_ref TEXT NOT NULL
) STRICT;
CREATE TABLE asset_locations (
    sha256 TEXT NOT NULL,
    storage_profile_id TEXT NOT NULL REFERENCES storage_profiles(id),
    object_key TEXT NOT NULL,
    public_url TEXT,
    uploaded_at INTEGER,
    deleted_at INTEGER,
    PRIMARY KEY(sha256, storage_profile_id)
) STRICT;

CREATE TABLE jobs (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    entry_id TEXT REFERENCES entries(id),
    asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
    sha256 TEXT,
    source_url TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE backup_records (
    id TEXT PRIMARY KEY NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('backup','restore')),
    object_key TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    created_at INTEGER NOT NULL
) STRICT;

CREATE VIRTUAL TABLE entries_fts USING fts5(title, content_md, content='entries', content_rowid='rowid', tokenize='trigram');
CREATE TRIGGER entries_fts_insert AFTER INSERT ON entries BEGIN
    INSERT INTO entries_fts(rowid, title, content_md) VALUES (new.rowid, new.title, new.content_md);
END;
CREATE TRIGGER entries_fts_delete AFTER DELETE ON entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, title, content_md) VALUES ('delete', old.rowid, old.title, old.content_md);
END;
CREATE TRIGGER entries_fts_update AFTER UPDATE OF title, content_md ON entries
WHEN old.title <> new.title OR old.content_md <> new.content_md
BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, title, content_md) VALUES ('delete', old.rowid, old.title, old.content_md);
    INSERT INTO entries_fts(rowid, title, content_md) VALUES (new.rowid, new.title, new.content_md);
END;
