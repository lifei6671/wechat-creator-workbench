CREATE UNIQUE INDEX jobs_wechat_url ON jobs(source_url) WHERE kind='wechat_import';
CREATE UNIQUE INDEX jobs_import_image ON jobs(asset_id) WHERE kind='import_image';
CREATE UNIQUE INDEX assets_derived_source_hash ON assets(source_key, sha256) WHERE kind='derived';
CREATE TABLE wechat_sources (
    url TEXT PRIMARY KEY NOT NULL,
    entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE
) STRICT;
