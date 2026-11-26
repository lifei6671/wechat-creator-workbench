CREATE TABLE editor_recovery (
    entry_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    entry_kind TEXT NOT NULL,
    base_version INTEGER NOT NULL,
    local_revision INTEGER NOT NULL,
    saved_revision INTEGER NOT NULL DEFAULT 0,
    fields_json TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(entry_id,session_id)
) STRICT;
