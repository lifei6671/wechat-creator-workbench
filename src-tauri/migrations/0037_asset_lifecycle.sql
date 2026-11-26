CREATE TABLE asset_cleanup_candidates (
    sha256 TEXT PRIMARY KEY,
    first_unreferenced_at INTEGER NOT NULL,
    last_checked_at INTEGER NOT NULL
) STRICT;
CREATE TABLE asset_public_protection (
    sha256 TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
) STRICT;
INSERT INTO asset_public_protection SELECT DISTINCT sha256,CAST(unixepoch('subsec')*1000 AS INTEGER) FROM asset_locations;
CREATE TRIGGER protect_public_asset_insert AFTER INSERT ON asset_locations BEGIN
    INSERT OR IGNORE INTO asset_public_protection VALUES(NEW.sha256,CAST(unixepoch('subsec')*1000 AS INTEGER));
END;
CREATE TRIGGER protect_public_asset_update AFTER UPDATE ON asset_locations BEGIN
    INSERT OR IGNORE INTO asset_public_protection VALUES(NEW.sha256,CAST(unixepoch('subsec')*1000 AS INTEGER));
END;
CREATE TABLE backup_asset_manifests (
    scope TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','confirmed','unverified')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY(scope,snapshot)
) STRICT;
CREATE TABLE backup_asset_references (
    scope TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    PRIMARY KEY(scope,snapshot,sha256),
    FOREIGN KEY(scope,snapshot) REFERENCES backup_asset_manifests(scope,snapshot) ON DELETE CASCADE
) STRICT;

CREATE TRIGGER asset_cleanup_cancel_insert AFTER INSERT ON assets BEGIN
    DELETE FROM asset_cleanup_candidates WHERE sha256=NEW.sha256;
END;
CREATE TRIGGER asset_cleanup_cancel_update AFTER UPDATE ON assets BEGIN
    DELETE FROM asset_cleanup_candidates WHERE sha256=NEW.sha256;
END;

CREATE TRIGGER asset_cleanup_cancel_card_insert AFTER INSERT ON collection_nodes WHEN NEW.asset_id IS NOT NULL BEGIN
    DELETE FROM asset_cleanup_candidates WHERE sha256 IN (SELECT sha256 FROM assets WHERE id=NEW.asset_id);
END;
CREATE TRIGGER asset_cleanup_cancel_card_update AFTER UPDATE OF asset_id ON collection_nodes WHEN NEW.asset_id IS NOT NULL BEGIN
    DELETE FROM asset_cleanup_candidates WHERE sha256 IN (SELECT sha256 FROM assets WHERE id=NEW.asset_id);
END;
