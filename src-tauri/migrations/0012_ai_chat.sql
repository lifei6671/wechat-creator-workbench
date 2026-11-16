ALTER TABLE ai_job_details RENAME TO previous_ai_job_details;

CREATE TABLE ai_job_details (
    job_id TEXT PRIMARY KEY NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    operation TEXT NOT NULL CHECK (operation IN ('summary', 'titles', 'rewrite', 'chat')),
    model TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    total_tokens INTEGER
) STRICT;

INSERT INTO ai_job_details (job_id, operation, model, input_tokens, output_tokens, total_tokens)
SELECT job_id, operation, model, input_tokens, output_tokens, total_tokens FROM previous_ai_job_details;

DROP TABLE previous_ai_job_details;
