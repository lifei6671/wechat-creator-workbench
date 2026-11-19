ALTER TABLE sync_devices ADD COLUMN admin_recovery_hash TEXT;
ALTER TABLE sync_devices ADD COLUMN admin_recovery_expires_at INTEGER;

CREATE UNIQUE INDEX sync_device_admin_recovery_hash ON sync_devices (admin_recovery_hash)
WHERE admin_recovery_hash IS NOT NULL;
