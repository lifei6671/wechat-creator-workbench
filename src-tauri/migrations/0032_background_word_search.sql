CREATE VIRTUAL TABLE entries_words_alt_fts USING fts5(title_words, body_words, tokenize='ascii');

CREATE TABLE search_index_state (
    id INTEGER PRIMARY KEY CHECK(id=1),
    active_slot INTEGER NOT NULL DEFAULT 0 CHECK(active_slot IN (0,1)),
    signature TEXT NOT NULL DEFAULT '',
    generation INTEGER NOT NULL DEFAULT 0,
    building INTEGER NOT NULL DEFAULT 0 CHECK(building IN (0,1))
) STRICT;
INSERT INTO search_index_state(id,signature)
VALUES(1,COALESCE((SELECT value FROM app_settings WHERE key='search.word_index_signature'),''));
DELETE FROM app_settings WHERE key='search.word_index_signature';

CREATE TABLE search_index_dirty (
    entry_rowid INTEGER PRIMARY KEY,
    revision INTEGER NOT NULL
) STRICT;

DROP TRIGGER entries_words_insert;
DROP TRIGGER entries_words_update;
DROP TRIGGER entries_words_delete;

CREATE TRIGGER entries_words_insert AFTER INSERT ON entries
BEGIN
    INSERT INTO entries_words_fts(rowid,title_words,body_words)
    SELECT new.rowid,workspace_search_tokens(new.title),workspace_search_tokens(new.content_md)
    WHERE new.purged_at IS NULL AND (SELECT active_slot FROM search_index_state WHERE id=1)=0;
    INSERT INTO entries_words_alt_fts(rowid,title_words,body_words)
    SELECT new.rowid,workspace_search_tokens(new.title),workspace_search_tokens(new.content_md)
    WHERE new.purged_at IS NULL AND (SELECT active_slot FROM search_index_state WHERE id=1)=1;
    INSERT INTO search_index_dirty(entry_rowid,revision)
    SELECT new.rowid,1 WHERE (SELECT building FROM search_index_state WHERE id=1)=1
    ON CONFLICT(entry_rowid) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER entries_words_update AFTER UPDATE OF title, content_md, purged_at ON entries
WHEN old.title IS NOT new.title OR old.content_md IS NOT new.content_md OR old.purged_at IS NOT new.purged_at
BEGIN
    DELETE FROM entries_words_fts WHERE rowid=old.rowid AND (SELECT active_slot FROM search_index_state WHERE id=1)=0;
    DELETE FROM entries_words_alt_fts WHERE rowid=old.rowid AND (SELECT active_slot FROM search_index_state WHERE id=1)=1;
    INSERT INTO entries_words_fts(rowid,title_words,body_words)
    SELECT new.rowid,workspace_search_tokens(new.title),workspace_search_tokens(new.content_md)
    WHERE new.purged_at IS NULL AND (SELECT active_slot FROM search_index_state WHERE id=1)=0;
    INSERT INTO entries_words_alt_fts(rowid,title_words,body_words)
    SELECT new.rowid,workspace_search_tokens(new.title),workspace_search_tokens(new.content_md)
    WHERE new.purged_at IS NULL AND (SELECT active_slot FROM search_index_state WHERE id=1)=1;
    INSERT INTO search_index_dirty(entry_rowid,revision)
    SELECT new.rowid,1 WHERE (SELECT building FROM search_index_state WHERE id=1)=1
    ON CONFLICT(entry_rowid) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER entries_words_delete AFTER DELETE ON entries
BEGIN
    DELETE FROM entries_words_fts WHERE rowid=old.rowid AND (SELECT active_slot FROM search_index_state WHERE id=1)=0;
    DELETE FROM entries_words_alt_fts WHERE rowid=old.rowid AND (SELECT active_slot FROM search_index_state WHERE id=1)=1;
    INSERT INTO search_index_dirty(entry_rowid,revision)
    SELECT old.rowid,1 WHERE (SELECT building FROM search_index_state WHERE id=1)=1
    ON CONFLICT(entry_rowid) DO UPDATE SET revision=revision+1;
END;
