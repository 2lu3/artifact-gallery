DROP TRIGGER artifact_search_document_insert;
DROP TRIGGER artifact_search_document_update;
DROP TRIGGER artifact_search_document_delete;
DROP TABLE artifact_search_fts;

ALTER TABLE artifact_search_document
  ADD COLUMN format_normalized TEXT NOT NULL DEFAULT '';

UPDATE artifact_search_document
SET format_normalized = search_normalize(
  (SELECT format FROM artifact WHERE artifact.id = artifact_search_document.artifact_id)
);

CREATE VIRTUAL TABLE artifact_search_fts USING fts5(
  artifact_id UNINDEXED,
  generation UNINDEXED,
  user_title_normalized,
  derived_title_normalized,
  body_normalized,
  path_segments_normalized,
  format_normalized,
  tokenize='trigram'
);

CREATE TRIGGER artifact_search_document_insert
AFTER INSERT ON artifact_search_document
BEGIN
  INSERT INTO artifact_search_fts (
    rowid, artifact_id, generation, user_title_normalized, derived_title_normalized,
    body_normalized, path_segments_normalized, format_normalized
  ) VALUES (
    NEW.generation_id, NEW.artifact_id, NEW.generation, NEW.user_title_normalized,
    NEW.derived_title_normalized, NEW.body_normalized, NEW.path_segments_normalized,
    NEW.format_normalized
  );
END;

CREATE TRIGGER artifact_search_document_update
AFTER UPDATE ON artifact_search_document
BEGIN
  DELETE FROM artifact_search_fts WHERE rowid = OLD.generation_id;
  INSERT INTO artifact_search_fts (
    rowid, artifact_id, generation, user_title_normalized, derived_title_normalized,
    body_normalized, path_segments_normalized, format_normalized
  ) VALUES (
    NEW.generation_id, NEW.artifact_id, NEW.generation, NEW.user_title_normalized,
    NEW.derived_title_normalized, NEW.body_normalized, NEW.path_segments_normalized,
    NEW.format_normalized
  );
END;

CREATE TRIGGER artifact_search_document_delete
AFTER DELETE ON artifact_search_document
BEGIN
  DELETE FROM artifact_search_fts WHERE rowid = OLD.generation_id;
END;

INSERT INTO artifact_search_fts (
  rowid, artifact_id, generation, user_title_normalized, derived_title_normalized,
  body_normalized, path_segments_normalized, format_normalized
)
SELECT generation_id, artifact_id, generation, user_title_normalized,
       derived_title_normalized, body_normalized, path_segments_normalized,
       format_normalized
FROM artifact_search_document;
