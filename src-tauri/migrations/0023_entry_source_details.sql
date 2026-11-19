ALTER TABLE entries ADD COLUMN source_details TEXT;

UPDATE entries SET source_details=(
    SELECT json_object(
        'author',s.author,
        'accountName',s.account_name,
        'originalPublishedAt',s.original_published_at,
        'importedAt',s.imported_at
    )
    FROM sources s WHERE s.id=entries.source_id
) WHERE source_id IS NOT NULL;
