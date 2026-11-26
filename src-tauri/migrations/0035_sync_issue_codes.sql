ALTER TABLE sync_issues ADD COLUMN code TEXT;
CREATE INDEX sync_issues_code ON sync_issues(code,reason) WHERE remote_json IS NULL;
