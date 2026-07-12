export type WorkflowDefinitionStatus = 'DRAFT' | 'PUBLISHED' | 'RETIRED';
export type WorkflowDecision = 'APPROVED' | 'REJECTED';

export interface WorkflowDefinitionRecord {
  readonly id: string;
  readonly definition_key: string;
  readonly version: number;
  readonly status: WorkflowDefinitionStatus;
  readonly submit_permission: string;
  readonly approval_permission: string;
  readonly prohibit_requester_approval: boolean;
}

export interface WorkflowTaskRecord {
  readonly id: string;
  readonly instance_id: string;
  readonly requester_subject_id: string;
  readonly required_permission: string;
  readonly prohibit_requester_approval: boolean;
  readonly task_status: 'OPEN' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  readonly instance_version: number;
}

