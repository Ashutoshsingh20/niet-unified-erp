ALTER TABLE access.review_items
  ADD COLUMN assignment_version_at_review integer NOT NULL,
  ADD COLUMN decided_by text;

ALTER TABLE access.review_items
  ADD CONSTRAINT review_item_actor_consistency CHECK (
    (decision IS NULL AND decided_by IS NULL)
    OR (decision IS NOT NULL AND decided_by IS NOT NULL)
  );

