CREATE TABLE ai_job_details (
    job_id TEXT PRIMARY KEY NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    operation TEXT NOT NULL CHECK (operation IN ('summary', 'titles', 'rewrite')),
    model TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    total_tokens INTEGER
) STRICT;
