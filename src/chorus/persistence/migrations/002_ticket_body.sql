ALTER TABLE tickets ADD COLUMN body TEXT NOT NULL DEFAULT '';

UPDATE tickets
SET body = description
WHERE body = '' AND description != '';
