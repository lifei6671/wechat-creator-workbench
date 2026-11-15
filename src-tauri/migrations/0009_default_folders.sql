INSERT OR IGNORE INTO categories (id, parent_id, name, depth, sort_order, icon)
SELECT folders.id, NULL, folders.name, 1, existing.next_order + folders.position, folders.icon
FROM (
    SELECT 'builtin-articles' AS id, '文章' AS name, 'file' AS icon, 0 AS position
    UNION ALL SELECT 'builtin-ideas', '灵感', 'lightbulb', 1
    UNION ALL SELECT 'builtin-references', '资料', 'book', 2
) AS folders
CROSS JOIN (SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM categories WHERE parent_id IS NULL) AS existing;
