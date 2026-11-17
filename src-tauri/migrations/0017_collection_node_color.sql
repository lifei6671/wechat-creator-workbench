ALTER TABLE collection_nodes ADD COLUMN color TEXT
    CHECK (color IN ('red', 'orange', 'amber', 'green', 'blue', 'violet'));
