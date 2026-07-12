'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { erpRequest } from '@/lib/client-api';
import type { WorkflowTask } from '@/lib/workflow-types';

interface NotificationItem { id: string; title: string; readAt: string | null; }

export function Dashboard(): React.ReactNode {
  const tasks = useQuery({ queryKey: ['workflow-tasks'], queryFn: () =>
    erpRequest<{ items: WorkflowTask[] }>('v1/workflows/tasks?limit=20') });
  const notifications = useQuery({ queryKey: ['notifications'], queryFn: () =>
    erpRequest<{ items: NotificationItem[] }>('v1/notifications?limit=20') });
  if (tasks.isLoading || notifications.isLoading) return <Loading label="Loading your NIET overview" />;
  const taskCount = tasks.data?.items.length;
  const unread = notifications.data?.items.filter((item) => item.readAt === null).length;
  return <>
    {(tasks.isError || notifications.isError) && <div className="error-banner" role="alert">Some live information is unavailable. Your access may not include every dashboard source.</div>}
    <section className="summary-grid" aria-label="Current workload">
      <div className="summary"><div className="summary-label">Open approval tasks</div>
        <div className="summary-value">{taskCount ?? '—'}</div></div>
      <div className="summary"><div className="summary-label">Unread notifications</div>
        <div className="summary-value">{unread ?? '—'}</div></div>
      <div className="summary"><div className="summary-label">Data source</div>
        <div className="summary-value summary-value-small">Live & scoped</div></div>
    </section>
    <section className="panel"><div className="panel-header"><h2>Next actions</h2></div><div className="panel-body button-row">
      <Link className="button button-primary" href="/workflows">Open tasks and approvals</Link>
      <Link className="button button-secondary" href="/notifications">View notifications</Link>
    </div></section>
  </>;
}

function Loading({ label }: { label: string }): React.ReactNode {
  return <div className="panel" role="status" aria-label={label}><div className="loading-lines"><span /><span /><span /></div></div>;
}
