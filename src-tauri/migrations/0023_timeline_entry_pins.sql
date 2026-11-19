CREATE TABLE timeline_entry_pins (
    scope TEXT NOT NULL,
    entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    pin_order INTEGER NOT NULL,
    PRIMARY KEY (scope, entry_id)
) WITHOUT ROWID;
CREATE INDEX timeline_entry_pins_entry ON timeline_entry_pins(entry_id);
