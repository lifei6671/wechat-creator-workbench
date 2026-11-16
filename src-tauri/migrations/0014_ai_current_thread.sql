WITH ranked_threads AS (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY entry_id ORDER BY updated_at DESC, rowid DESC) AS position
    FROM ai_threads
    WHERE archived = 0
)
UPDATE ai_threads
SET archived = 1
WHERE id IN (SELECT id FROM ranked_threads WHERE position > 1);
