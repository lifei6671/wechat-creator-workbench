ALTER TABLE sync_outbox ADD COLUMN origin_device_id TEXT NOT NULL DEFAULT '';
UPDATE sync_outbox SET origin_device_id=(SELECT device_id FROM sync_binding WHERE id=1)
WHERE EXISTS(SELECT 1 FROM sync_binding WHERE id=1);

ALTER TABLE sync_binding ADD COLUMN pause_reason TEXT;
UPDATE sync_binding SET pause_reason='legacy_review' WHERE paused=1;
