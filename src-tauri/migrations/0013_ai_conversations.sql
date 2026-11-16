CREATE TABLE ai_threads (
    id TEXT PRIMARY KEY NOT NULL,
    entry_id TEXT REFERENCES entries(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT '',
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_ai_threads_entry_time ON ai_threads(entry_id, updated_at DESC);

CREATE TABLE ai_messages (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    thread_id TEXT NOT NULL REFERENCES ai_threads(id) ON DELETE CASCADE,
    parent_id TEXT,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content_json TEXT NOT NULL CHECK (json_valid(content_json)),
    created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_ai_messages_thread_order ON ai_messages(thread_id, seq);

CREATE TABLE ai_edit_proposals (
    id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT NOT NULL REFERENCES ai_threads(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL UNIQUE REFERENCES ai_messages(id) ON DELETE CASCADE,
    entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    base_version INTEGER NOT NULL,
    local_revision INTEGER NOT NULL,
    target_from INTEGER NOT NULL,
    target_to INTEGER NOT NULL CHECK (target_to > target_from),
    original_markdown TEXT NOT NULL,
    original_slice_hash TEXT NOT NULL,
    replacement_markdown TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'rejected', 'conflicted')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;
