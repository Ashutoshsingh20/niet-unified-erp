'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { ErpApiError, erpRequest } from '@/lib/client-api';
import type { WorkflowDefinition, WorkflowRequest, WorkflowTask } from '@/lib/workflow-types';

const requestSchema = z.object({
  definitionKey: z.string().min(1, 'Choose a request type'),
  title: z.string().trim().min(3, 'Enter at least 3 characters').max(200),
  description: z.string().trim().min(3, 'Describe the request').max(2000),
  scopeType: z.string().regex(/^[a-z][a-z0-9_.-]{1,49}$/, 'Enter a valid scope type'),
  scopeId: z.string().trim().min(1, 'Enter a scope identifier').max(200),
});
type RequestForm = z.infer<typeof requestSchema>;

export function WorkflowWorkspace(): React.ReactNode {
  const queryClient = useQueryClient();
  const tasks = useQuery({ queryKey: ['workflow-tasks'], queryFn: () =>
    erpRequest<{ items: WorkflowTask[] }>('v1/workflows/tasks?limit=50') });
  const requests = useQuery({ queryKey: ['workflow-requests'], queryFn: () =>
    erpRequest<{ items: WorkflowRequest[] }>('v1/workflows/requests/mine?limit=50') });
  const definitions = useQuery({ queryKey: ['workflow-definitions'], queryFn: () =>
    erpRequest<{ items: WorkflowDefinition[] }>('v1/workflows/definitions/available') });
  const form = useForm<RequestForm>({ resolver: zodResolver(requestSchema),
    defaultValues: { definitionKey: '', title: '', description: '', scopeType: '', scopeId: '' } });
  const submit = useMutation({ mutationFn: (values: RequestForm) => erpRequest('v1/workflows/requests', {
    method: 'POST', body: JSON.stringify({ definitionKey: values.definitionKey, title: values.title,
      requestData: { description: values.description }, scopeType: values.scopeType, scopeId: values.scopeId }),
  }), onSuccess: async () => { form.reset(); await queryClient.invalidateQueries({ queryKey: ['workflow-requests'] }); } });
  const taskItems = tasks.data?.items ?? [];
  const requestItems = requests.data?.items ?? [];

  return <div className="two-column">
    <div>
      <section className="panel" aria-labelledby="approval-heading">
        <div className="panel-header"><h2 id="approval-heading">Approval inbox</h2>
          <span className="badge">{taskItems.length} open</span></div>
        {tasks.isLoading ? <Loading /> : tasks.isError ? <LoadError />
          : taskItems.length === 0 ? <div className="empty-state">No approval tasks are assigned to your current scope.</div>
            : <ul className="data-list">{taskItems.map((task) => <TaskItem task={task} key={task.id} />)}</ul>}
      </section>
      <section className="panel" aria-labelledby="requests-heading">
        <div className="panel-header"><h2 id="requests-heading">My requests</h2></div>
        {requests.isLoading ? <Loading /> : requests.isError ? <LoadError />
          : requestItems.length === 0 ? <div className="empty-state">You have not submitted a request yet.</div>
            : <ul className="data-list">{requestItems.map((request) => <li key={request.id}>
              <div className="item-title">{request.title}</div><div className="item-meta">
                <StatusBadge status={request.status} /><span>{request.definitionKey}</span>
                <span>{request.scopeType}: {request.scopeId}</span>
                <time dateTime={request.submittedAt}>{new Date(request.submittedAt).toLocaleString()}</time>
              </div>{request.decisionReason !== null && <p className="help">Decision note: {request.decisionReason}</p>}
            </li>)}</ul>}
      </section>
    </div>
    <section className="panel" aria-labelledby="new-request-heading">
      <div className="panel-header"><h2 id="new-request-heading">New request</h2></div>
      <div className="panel-body">
        {definitions.isError && <LoadError />}
        {submit.isSuccess && <div className="success-banner" role="status">Request submitted for approval.</div>}
        {submit.isError && <MutationError error={submit.error} />}
        <form className="form-grid" onSubmit={(event) => {
          void form.handleSubmit((values) => submit.mutate(values))(event);
        }}>
          <div className="field"><label htmlFor="definition">Request type</label>
            <select id="definition" {...form.register('definitionKey')} disabled={definitions.isLoading}>
              <option value="">Select a configured workflow</option>
              {definitions.data?.items.map((item) => <option value={item.key} key={item.key}>{item.title}</option>)}
            </select>{form.formState.errors.definitionKey && <p className="field-error">{form.formState.errors.definitionKey.message}</p>}</div>
          <div className="field"><label htmlFor="request-title">Title</label>
            <input id="request-title" autoComplete="off" {...form.register('title')} />
            {form.formState.errors.title && <p className="field-error">{form.formState.errors.title.message}</p>}</div>
          <div className="field"><label htmlFor="request-description">Reason and supporting detail</label>
            <textarea id="request-description" {...form.register('description')} />
            {form.formState.errors.description && <p className="field-error">{form.formState.errors.description.message}</p>}</div>
          <div className="field"><label htmlFor="scope-type">Scope type</label>
            <input id="scope-type" placeholder="For example, organization" {...form.register('scopeType')} />
            {form.formState.errors.scopeType && <p className="field-error">{form.formState.errors.scopeType.message}</p>}</div>
          <div className="field"><label htmlFor="scope-id">Scope identifier</label>
            <input id="scope-id" {...form.register('scopeId')} />
            <p className="help">Use an identifier within your assigned access. The server rejects broader scope.</p>
            {form.formState.errors.scopeId && <p className="field-error">{form.formState.errors.scopeId.message}</p>}</div>
          <button className="button button-primary" type="submit" disabled={submit.isPending || definitions.data?.items.length === 0}>
            {submit.isPending ? 'Submitting…' : 'Submit request'}</button>
        </form>
      </div>
    </section>
  </div>;
}

function TaskItem({ task }: { task: WorkflowTask }): React.ReactNode {
  const [reason, setReason] = useState('');
  const queryClient = useQueryClient();
  const decide = useMutation({ mutationFn: (decision: 'APPROVED' | 'REJECTED') =>
    erpRequest(`v1/workflows/tasks/${task.id}/decision`, { method: 'POST',
      body: JSON.stringify({ decision, reason, expectedVersion: task.instanceVersion }) }),
    onSuccess: async () => { await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['workflow-tasks'] }),
      queryClient.invalidateQueries({ queryKey: ['workflow-requests'] }),
    ]); } });
  return <li><div className="item-title">{task.title}</div><div className="item-meta">
    <span>Requested by {task.requesterSubjectId}</span><span>{task.scopeType}: {task.scopeId}</span>
    <time dateTime={task.createdAt}>{new Date(task.createdAt).toLocaleString()}</time></div>
    <div className="task-decision"><label className="fieldset-label" htmlFor={`reason-${task.id}`}>Decision reason</label>
      <textarea id={`reason-${task.id}`} value={reason} maxLength={1000}
        onChange={(event) => setReason(event.target.value)} />
      {decide.isError && <MutationError error={decide.error} />}
      <div className="button-row"><button className="button button-primary" type="button"
        disabled={reason.trim().length < 3 || decide.isPending} onClick={() => decide.mutate('APPROVED')}>Approve</button>
        <button className="button button-danger" type="button" disabled={reason.trim().length < 3 || decide.isPending}
          onClick={() => decide.mutate('REJECTED')}>Reject</button>
        <Link href={`/auth/login?stepUp=true&returnTo=${encodeURIComponent('/workflows')}`}>Re-authenticate for protected actions</Link></div>
    </div></li>;
}

function StatusBadge({ status }: { status: WorkflowRequest['status'] }): React.ReactNode {
  return <span className={`badge badge-${status.toLowerCase()}`}>{status.toLowerCase()}</span>;
}
function Loading(): React.ReactNode { return <div className="loading-lines" role="status" aria-label="Loading"><span /><span /><span /></div>; }
function LoadError(): React.ReactNode { return <div className="error-banner" role="alert">This information could not be loaded. Check your access or try again.</div>; }
function MutationError({ error }: { error: Error }): React.ReactNode {
  const text = error instanceof ErpApiError && error.status === 403
    ? 'The action is outside your permission or requires re-authentication.' : error.message;
  return <div className="error-banner" role="alert">{text}</div>;
}
