CREATE TABLE artifact (
  id INTEGER PRIMARY KEY,
  source_path TEXT NOT NULL UNIQUE,
  format TEXT NOT NULL CHECK (format IN ('markdown', 'html')),
  derived_title TEXT,
  user_title TEXT,
  source_status TEXT NOT NULL CHECK (source_status IN ('available', 'missing')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  active_generation_id INTEGER,
  generation_counter INTEGER NOT NULL DEFAULT 0 CHECK (generation_counter >= 0),
  FOREIGN KEY (active_generation_id, id)
    REFERENCES artifact_generation(id, artifact_id)
) STRICT;

CREATE TABLE artifact_generation (
  id INTEGER PRIMARY KEY,
  artifact_id INTEGER NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK (generation > 0),
  job_status TEXT NOT NULL CHECK (job_status IN ('queued', 'processing', 'idle', 'interrupted')),
  content_status TEXT NOT NULL CHECK (content_status IN ('pending', 'ready', 'failed')),
  render_status TEXT NOT NULL CHECK (render_status IN ('pending', 'ready', 'failed')),
  index_status TEXT NOT NULL CHECK (index_status IN ('pending', 'ready', 'failed')),
  extracted_text TEXT,
  extractor_version TEXT,
  thumbnail_path TEXT,
  previewed_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  UNIQUE (artifact_id, generation),
  UNIQUE (id, artifact_id)
) STRICT;

CREATE TABLE artifact_error (
  id INTEGER PRIMARY KEY,
  artifact_id INTEGER REFERENCES artifact(id) ON DELETE CASCADE,
  generation_id INTEGER,
  code TEXT NOT NULL,
  stage TEXT NOT NULL,
  retryable INTEGER NOT NULL CHECK (retryable IN (0, 1)),
  user_message TEXT NOT NULL,
  technical_detail TEXT,
  occurred_at TEXT NOT NULL,
  CHECK (generation_id IS NULL OR artifact_id IS NOT NULL),
  UNIQUE (id, artifact_id),
  FOREIGN KEY (generation_id, artifact_id)
    REFERENCES artifact_generation(id, artifact_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE artifact_warning (
  id INTEGER PRIMARY KEY,
  artifact_id INTEGER NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
  generation_id INTEGER,
  code TEXT NOT NULL,
  detail TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (generation_id, artifact_id)
    REFERENCES artifact_generation(id, artifact_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE allowed_root (
  id INTEGER PRIMARY KEY,
  canonical_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE import_run (
  id INTEGER PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted')),
  cancel_requested_at TEXT,
  started_at TEXT,
  completed_at TEXT
) STRICT;

CREATE TABLE import_item (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES import_run(id) ON DELETE CASCADE,
  canonical_path TEXT NOT NULL,
  artifact_id INTEGER REFERENCES artifact(id) ON DELETE SET NULL,
  stage TEXT NOT NULL CHECK (stage IN ('queued', 'inspect', 'extract', 'render', 'index', 'commit')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled', 'interrupted')),
  error_id INTEGER REFERENCES artifact_error(id) ON DELETE SET NULL,
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (error_id, artifact_id)
    REFERENCES artifact_error(id, artifact_id)
) STRICT;

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

CREATE INDEX artifact_generation_artifact_id_idx ON artifact_generation (artifact_id);
CREATE INDEX artifact_error_artifact_id_idx ON artifact_error (artifact_id);
CREATE INDEX artifact_warning_artifact_id_idx ON artifact_warning (artifact_id);
CREATE INDEX import_item_run_id_idx ON import_item (run_id);
