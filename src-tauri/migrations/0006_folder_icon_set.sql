CREATE TEMP TABLE category_icons_v6 AS SELECT id, icon FROM categories;
ALTER TABLE categories DROP COLUMN icon;
ALTER TABLE categories ADD COLUMN icon TEXT NOT NULL DEFAULT 'folder'
    CHECK (icon IN (
        'folder', 'lightbulb', 'book', 'file', 'bookmark', 'newspaper', 'archive', 'star',
        'code', 'terminal', 'globe', 'link', 'image', 'camera', 'video', 'music',
        'mic', 'podcast', 'headphones', 'pen', 'notebook', 'clipboard', 'briefcase', 'graduation',
        'flask', 'cpu', 'rocket', 'sparkles', 'heart', 'calendar', 'list', 'tag'
    ));
UPDATE categories SET icon = (SELECT icon FROM category_icons_v6 WHERE id = categories.id);
DROP TABLE category_icons_v6;
