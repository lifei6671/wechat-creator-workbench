ALTER TABLE categories ADD COLUMN icon TEXT NOT NULL DEFAULT 'folder'
    CHECK (icon IN ('folder', 'lightbulb', 'book', 'file', 'bookmark', 'newspaper', 'archive', 'star'));
