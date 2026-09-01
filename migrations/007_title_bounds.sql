UPDATE artifact
SET user_title = artifact_title_clamp(user_title),
    derived_title = artifact_title_clamp(derived_title)
WHERE user_title IS NOT artifact_title_clamp(user_title)
   OR derived_title IS NOT artifact_title_clamp(derived_title);

UPDATE artifact_search_document
SET user_title_normalized = search_normalize(
      (SELECT user_title FROM artifact WHERE artifact.id = artifact_search_document.artifact_id)
    ),
    derived_title_normalized = search_normalize(
      (SELECT derived_title FROM artifact WHERE artifact.id = artifact_search_document.artifact_id)
    );
