export interface WorkflowTask {
  id: string; instanceId: string; title: string; requesterSubjectId: string;
  requiredPermission: string; scopeType: string; scopeId: string; createdAt: string;
  instanceVersion: number;
}
export interface WorkflowRequest {
  id: string; definitionKey: string; title: string; status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  scopeType: string; scopeId: string; submittedAt: string; decidedAt: string | null;
  decisionReason: string | null; version: number;
}
export interface WorkflowDefinition { key: string; version: number; title: string; description: string; }

