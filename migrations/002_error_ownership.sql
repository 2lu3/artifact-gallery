PRAGMA defer_foreign_keys = ON;

CREATE TABLE artifact_error_new (
  id INTEGER PRIMARY KEY,
  artifact_id INTEGER REFERENCES artifact(id) ON DELETE CASCADE,
  generation_id INTEGER REFERENCES artifact_generation(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  stage TEXT NOT NULL,
  retryable INTEGER NOT NULL CHECK (retryable IN (0, 1)),
  user_message TEXT NOT NULL,
  technical_detail TEXT,
  occurred_at TEXT NOT NULL,
  CHECK (generation_id IS NULL OR artifact_id IS NOT NULL)
) STRICT;

CREATE TABLE import_item_new (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES import_run(id) ON DELETE CASCADE,
  canonical_path TEXT NOT NULL,
  artifact_id INTEGER REFERENCES artifact(id) ON DELETE SET NULL,
  stage TEXT NOT NULL CHECK (stage IN ('queued', 'inspect', 'extract', 'render', 'index', 'commit')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled', 'interrupted')),
  error_id INTEGER REFERENCES artifact_error_new(id) ON DELETE SET NULL,
  started_at TEXT,
  completed_at TEXT
) STRICT;

INSERT INTO artifact_error_new (
  id,
  artifact_id,
  generation_id,
  code,
  stage,
  retryable,
  user_message,
  technical_detail,
  occurred_at
)
SELECT
  id,
  artifact_id,
  generation_id,
  code,
  stage,
  retryable,
  user_message,
  technical_detail,
  occurred_at
FROM artifact_error;

INSERT INTO import_item_new (
  id,
  run_id,
  canonical_path,
  artifact_id,
  stage,
  status,
  error_id,
  started_at,
  completed_at
)
SELECT
  id,
  run_id,
  canonical_path,
  artifact_id,
  stage,
  status,
  error_id,
  started_at,
  completed_at
FROM import_item;

DROP TABLE import_item;
DROP TABLE artifact_error;
ALTER TABLE artifact_error_new RENAME TO artifact_error;
ALTER TABLE import_item_new RENAME TO import_item;

CREATE INDEX artifact_error_artifact_id_idx ON artifact_error (artifact_id);
CREATE INDEX import_item_run_id_idx ON import_item (run_id);

CREATE TRIGGER artifact_active_generation_owner_insert
AFTER INSERT ON artifact
WHEN NEW.active_generation_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM artifact_generation
    WHERE artifact_generation.id = NEW.active_generation_id
      AND artifact_generation.artifact_id = NEW.id
  )
BEGIN
  SELECT RAISE(ABORT, 'artifact active generation owner mismatch');
END;

CREATE TRIGGER artifact_active_generation_owner_update
BEFORE UPDATE OF active_generation_id ON artifact
WHEN NEW.active_generation_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM artifact_generation
    WHERE artifact_generation.id = NEW.active_generation_id
      AND artifact_generation.artifact_id = NEW.id
  )
BEGIN
  SELECT RAISE(ABORT, 'artifact active generation owner mismatch');
END;

CREATE TRIGGER artifact_error_generation_owner_insert
BEFORE INSERT ON artifact_error
WHEN NEW.generation_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM artifact_generation
    WHERE artifact_generation.id = NEW.generation_id
      AND artifact_generation.artifact_id = NEW.artifact_id
  )
BEGIN
  SELECT RAISE(ABORT, 'artifact error generation owner mismatch');
END;

CREATE TRIGGER artifact_error_generation_owner_update
BEFORE UPDATE OF generation_id, artifact_id ON artifact_error
WHEN NEW.generation_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM artifact_generation
    WHERE artifact_generation.id = NEW.generation_id
      AND artifact_generation.artifact_id = NEW.artifact_id
  )
BEGIN
  SELECT RAISE(ABORT, 'artifact error generation owner mismatch');
END;

CREATE TRIGGER artifact_warning_generation_owner_insert
BEFORE INSERT ON artifact_warning
WHEN NEW.generation_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM artifact_generation
    WHERE artifact_generation.id = NEW.generation_id
      AND artifact_generation.artifact_id = NEW.artifact_id
  )
BEGIN
  SELECT RAISE(ABORT, 'artifact warning generation owner mismatch');
END;

CREATE TRIGGER artifact_warning_generation_owner_update
BEFORE UPDATE OF generation_id, artifact_id ON artifact_warning
WHEN NEW.generation_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM artifact_generation
    WHERE artifact_generation.id = NEW.generation_id
      AND artifact_generation.artifact_id = NEW.artifact_id
  )
BEGIN
  SELECT RAISE(ABORT, 'artifact warning generation owner mismatch');
END;

CREATE TRIGGER import_item_error_owner_insert
BEFORE INSERT ON import_item
WHEN NEW.error_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM artifact_error
    WHERE artifact_error.id = NEW.error_id
      AND artifact_error.artifact_id IS NEW.artifact_id
  )
BEGIN
  SELECT RAISE(ABORT, 'import item error owner mismatch');
END;

CREATE TRIGGER import_item_error_owner_update
BEFORE UPDATE OF error_id, artifact_id ON import_item
WHEN NEW.error_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM artifact_error
    WHERE artifact_error.id = NEW.error_id
      AND artifact_error.artifact_id IS NEW.artifact_id
  )
BEGIN
  SELECT RAISE(ABORT, 'import item error owner mismatch');
END;

CREATE TRIGGER artifact_clear_import_item_errors_before_delete
BEFORE DELETE ON artifact
BEGIN
  UPDATE import_item
  SET error_id = NULL
  WHERE artifact_id = OLD.id AND error_id IS NOT NULL;
END;
