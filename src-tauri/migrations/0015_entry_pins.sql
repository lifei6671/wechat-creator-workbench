ALTER TABLE entries ADD COLUMN pinned_order INTEGER;
CREATE INDEX entries_pinned_order ON entries(pinned_order) WHERE pinned_order IS NOT NULL;
