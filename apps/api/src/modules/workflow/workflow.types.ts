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
  readonly scope_type: string;
  readonly scope_id: string;
}

export interface WorkflowTaskListItem {
  readonly id: string;
  readonly instanceId: string;
  readonly title: string;
  readonly requesterSubjectId: string;
  readonly requiredPermission: string;
  readonly scopeType: string;
  readonly scopeId: string;
  readonly createdAt: string;
  readonly instanceVersion: number;
}

export interface WorkflowRequestListItem {
  readonly id: string;
  readonly definitionKey: string;
  readonly title: string;
  readonly status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  readonly scopeType: string;
  readonly scopeId: string;
  readonly submittedAt: string;
  readonly decidedAt: string | null;
  readonly decisionReason: string | null;
  readonly version: number;
}

export interface WorkflowDefinitionListItem {
  readonly key: string;
  readonly version: number;
  readonly title: string;
  readonly description: string;
}
