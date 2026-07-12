import type { Metadata } from 'next';
import { WorkflowWorkspace } from '@/components/workflow-workspace';

export const metadata: Metadata = { title: 'Tasks and approvals' };

export default function WorkflowsPage(): React.ReactNode {
  return <><header className="page-header"><div><h1>Tasks and approvals</h1>
    <p>Submit configured requests, monitor your cases, and decide work assigned to your authorized scope.</p></div></header>
    <WorkflowWorkspace /></>;
}

