ALTER TABLE sync_devices ADD COLUMN recovery_hash TEXT;

CREATE UNIQUE INDEX sync_device_recovery_hash ON sync_devices (recovery_hash)
WHERE recovery_hash IS NOT NULL;
