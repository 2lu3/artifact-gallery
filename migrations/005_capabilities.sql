ALTER TABLE allowed_root
ADD COLUMN kind TEXT NOT NULL DEFAULT 'folder'
  CHECK (kind IN ('file', 'folder'));

CREATE TABLE artifact_allowed_root (
  artifact_id INTEGER PRIMARY KEY REFERENCES artifact(id) ON DELETE CASCADE,
  allowed_root_id INTEGER NOT NULL REFERENCES allowed_root(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX artifact_allowed_root_root_id_idx
  ON artifact_allowed_root (allowed_root_id);

-- Pre-capability catalogs stored only canonical artifact paths. Preserve their
-- access with the least-privilege exact-file grant; new folder selections are
-- linked explicitly by the registration boundary.
INSERT OR IGNORE INTO allowed_root (canonical_path, created_at, kind)
SELECT source_path, created_at, 'file'
FROM artifact;

UPDATE allowed_root
SET kind = 'file'
WHERE canonical_path IN (SELECT source_path FROM artifact);

INSERT OR IGNORE INTO artifact_allowed_root (artifact_id, allowed_root_id)
SELECT artifact.id, allowed_root.id
FROM artifact
JOIN allowed_root ON allowed_root.canonical_path = artifact.source_path;
