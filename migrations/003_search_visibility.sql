CREATE TABLE artifact_search_visibility (
  artifact_id INTEGER NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
  generation_id INTEGER PRIMARY KEY REFERENCES artifact_generation(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('staged', 'visible', 'quarantined')),
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX artifact_search_visibility_artifact_id_idx
  ON artifact_search_visibility (artifact_id);

CREATE TRIGGER artifact_search_visibility_generation_owner_insert
BEFORE INSERT ON artifact_search_visibility
WHEN NOT EXISTS (
  SELECT 1 FROM artifact_generation
  WHERE artifact_generation.id = NEW.generation_id
    AND artifact_generation.artifact_id = NEW.artifact_id
)
BEGIN
  SELECT RAISE(ABORT, 'artifact search visibility generation owner mismatch');
END;

CREATE TRIGGER artifact_search_visibility_generation_owner_update
BEFORE UPDATE OF generation_id, artifact_id ON artifact_search_visibility
WHEN NOT EXISTS (
  SELECT 1 FROM artifact_generation
  WHERE artifact_generation.id = NEW.generation_id
    AND artifact_generation.artifact_id = NEW.artifact_id
)
BEGIN
  SELECT RAISE(ABORT, 'artifact search visibility generation owner mismatch');
END;

INSERT INTO artifact_search_visibility (artifact_id, generation_id, state, updated_at)
SELECT
  artifact_generation.artifact_id,
  artifact_generation.id,
  CASE
    WHEN artifact.active_generation_id = artifact_generation.id
      AND artifact_generation.index_status = 'ready'
      THEN 'visible'
    ELSE 'staged'
  END,
  COALESCE(artifact_generation.completed_at, artifact_generation.started_at, artifact.updated_at)
FROM artifact_generation
JOIN artifact ON artifact.id = artifact_generation.artifact_id;
