ALTER TABLE assets ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE assets ADD COLUMN width INTEGER;
ALTER TABLE assets ADD COLUMN height INTEGER;
ALTER TABLE jobs ADD COLUMN storage_profile_id TEXT REFERENCES storage_profiles(id);
CREATE INDEX jobs_upload_queue ON jobs(kind, status, created_at);
CREATE UNIQUE INDEX jobs_cleanup_hash ON jobs(sha256) WHERE kind='cleanup';
CREATE TABLE asset_urls (
    url TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    storage_profile_id TEXT NOT NULL,
    PRIMARY KEY (url, sha256, storage_profile_id),
    FOREIGN KEY (sha256, storage_profile_id)
        REFERENCES asset_locations(sha256, storage_profile_id) ON DELETE CASCADE
) STRICT;
INSERT INTO asset_urls SELECT public_url, sha256, storage_profile_id FROM asset_locations WHERE public_url IS NOT NULL;
