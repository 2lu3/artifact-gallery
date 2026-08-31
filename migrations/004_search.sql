CREATE TABLE artifact_search_document (
  generation_id INTEGER PRIMARY KEY REFERENCES artifact_generation(id) ON DELETE CASCADE,
  artifact_id INTEGER NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK (generation > 0),
  user_title_normalized TEXT NOT NULL,
  derived_title_normalized TEXT NOT NULL,
  body_normalized TEXT NOT NULL,
  path_segments_normalized TEXT NOT NULL,
  UNIQUE (artifact_id, generation)
) STRICT;

CREATE INDEX artifact_search_document_artifact_id_idx
  ON artifact_search_document (artifact_id);

CREATE VIRTUAL TABLE artifact_search_fts USING fts5(
  artifact_id UNINDEXED,
  generation UNINDEXED,
  user_title_normalized,
  derived_title_normalized,
  body_normalized,
  path_segments_normalized,
  tokenize='trigram'
);

CREATE TRIGGER artifact_search_document_insert
AFTER INSERT ON artifact_search_document
BEGIN
  INSERT INTO artifact_search_fts (
    rowid,
    artifact_id,
    generation,
    user_title_normalized,
    derived_title_normalized,
    body_normalized,
    path_segments_normalized
  ) VALUES (
    NEW.generation_id,
    NEW.artifact_id,
    NEW.generation,
    NEW.user_title_normalized,
    NEW.derived_title_normalized,
    NEW.body_normalized,
    NEW.path_segments_normalized
  );
END;

CREATE TRIGGER artifact_search_document_update
AFTER UPDATE ON artifact_search_document
BEGIN
  DELETE FROM artifact_search_fts WHERE rowid = OLD.generation_id;
  INSERT INTO artifact_search_fts (
    rowid,
    artifact_id,
    generation,
    user_title_normalized,
    derived_title_normalized,
    body_normalized,
    path_segments_normalized
  ) VALUES (
    NEW.generation_id,
    NEW.artifact_id,
    NEW.generation,
    NEW.user_title_normalized,
    NEW.derived_title_normalized,
    NEW.body_normalized,
    NEW.path_segments_normalized
  );
END;

CREATE TRIGGER artifact_search_document_delete
AFTER DELETE ON artifact_search_document
BEGIN
  DELETE FROM artifact_search_fts WHERE rowid = OLD.generation_id;
END;

INSERT INTO artifact_search_document (
  generation_id,
  artifact_id,
  generation,
  user_title_normalized,
  derived_title_normalized,
  body_normalized,
  path_segments_normalized
)
SELECT
  artifact_generation.id,
  artifact.id,
  artifact_generation.generation,
  search_normalize(artifact.user_title),
  search_normalize(artifact.derived_title),
  search_normalize(artifact_generation.extracted_text),
  search_path_segments(artifact.source_path)
FROM artifact
JOIN artifact_generation
  ON artifact_generation.id = artifact.active_generation_id
 AND artifact_generation.artifact_id = artifact.id
JOIN artifact_search_visibility
  ON artifact_search_visibility.artifact_id = artifact.id
 AND artifact_search_visibility.generation_id = artifact_generation.id
WHERE artifact_generation.index_status = 'ready'
  AND artifact_search_visibility.state = 'visible';
