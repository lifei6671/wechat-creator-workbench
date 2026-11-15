ALTER TABLE entries ADD COLUMN folder_sort_order INTEGER;

CREATE TRIGGER entries_reset_folder_order AFTER UPDATE OF category_id ON entries
WHEN OLD.category_id IS NOT NEW.category_id AND NEW.folder_sort_order IS NOT NULL
BEGIN
    UPDATE entries SET folder_sort_order = NULL WHERE id = NEW.id;
END;
