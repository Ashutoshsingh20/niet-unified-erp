ALTER TABLE access.delegations
  ADD COLUMN source_assignment_id uuid REFERENCES access.subject_role_assignments(id);

CREATE INDEX delegations_source_assignment_idx
  ON access.delegations (source_assignment_id)
  WHERE status = 'ACTIVE';

