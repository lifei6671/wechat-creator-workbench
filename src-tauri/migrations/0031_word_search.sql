CREATE VIRTUAL TABLE entries_words_fts USING fts5(title_words, body_words, tokenize='ascii');

CREATE TRIGGER entries_words_insert AFTER INSERT ON entries
WHEN new.purged_at IS NULL
BEGIN
    INSERT INTO entries_words_fts(rowid,title_words,body_words)
    VALUES(new.rowid,workspace_search_tokens(new.title),workspace_search_tokens(new.content_md));
END;

CREATE TRIGGER entries_words_update AFTER UPDATE OF title, content_md, purged_at ON entries
WHEN old.title IS NOT new.title OR old.content_md IS NOT new.content_md OR old.purged_at IS NOT new.purged_at
BEGIN
    DELETE FROM entries_words_fts WHERE rowid=old.rowid;
    INSERT INTO entries_words_fts(rowid,title_words,body_words)
    SELECT new.rowid,workspace_search_tokens(new.title),workspace_search_tokens(new.content_md)
    WHERE new.purged_at IS NULL;
END;

CREATE TRIGGER entries_words_delete AFTER DELETE ON entries
BEGIN
    DELETE FROM entries_words_fts WHERE rowid=old.rowid;
END;
