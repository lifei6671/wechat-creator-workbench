CREATE TABLE sync_binding (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    url TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    epoch TEXT NOT NULL,
    device_id TEXT NOT NULL,
    paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1))
) STRICT;
