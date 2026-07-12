'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { erpRequest } from '@/lib/client-api';

interface NotificationItem {
  id: string; title: string; body: string; classification: string; actionPath: string | null;
  createdAt: string; readAt: string | null; expiresAt: string | null;
}
interface Preferences { externalPushEnabled: boolean; version: number; }

export function NotificationCentre(): React.ReactNode {
  const client = useQueryClient();
  const inbox = useQuery({ queryKey: ['notifications'], queryFn: () =>
    erpRequest<{ items: NotificationItem[] }>('v1/notifications?limit=100') });
  const preferences = useQuery({ queryKey: ['notification-preferences'], queryFn: () =>
    erpRequest<Preferences>('v1/notifications/preferences') });
  const updatePreferences = useMutation({ mutationFn: (enabled: boolean) =>
    erpRequest<Preferences>('v1/notifications/preferences', { method: 'PATCH',
      body: JSON.stringify({ externalPushEnabled: enabled,
        expectedVersion: preferences.data?.version ?? 0 }) }),
    onSuccess: (data) => client.setQueryData(['notification-preferences'], data) });
  const items = inbox.data?.items ?? [];
  return <div className="two-column"><section className="panel" aria-labelledby="inbox-heading">
    <div className="panel-header"><h2 id="inbox-heading">Inbox</h2>
      <span className="badge">{items.filter((item) => item.readAt === null).length} unread</span></div>
    {inbox.isLoading ? <div className="loading-lines" role="status"><span /><span /><span /></div>
      : inbox.isError ? <div className="error-banner" role="alert">Notifications could not be loaded.</div>
        : items.length === 0 ? <div className="empty-state">No current notifications.</div>
          : <ul className="data-list">{items.map((item) =>
            <NotificationRow item={item} key={item.id} />)}</ul>}
  </section><aside className="panel" aria-labelledby="delivery-heading"><div className="panel-header">
    <h2 id="delivery-heading">Delivery preference</h2></div><div className="panel-body">
      {preferences.isError && <div className="error-banner" role="alert">Preference could not be loaded.</div>}
      <label className="preference-row"><input type="checkbox"
        checked={preferences.data?.externalPushEnabled ?? false}
        disabled={preferences.isLoading || updatePreferences.isPending}
        onChange={(event) => updatePreferences.mutate(event.target.checked)} />
        <span><strong>Allow opaque mobile push events</strong><br /><span className="help">External push contains only an event identifier. Notification text is fetched from NIET after authentication.</span></span></label>
      {updatePreferences.isError && <div className="error-banner" role="alert">Preference changed elsewhere or could not be saved. Reload and try again.</div>}
    </div></aside></div>;
}

function NotificationRow({ item }: { item: NotificationItem }): React.ReactNode {
  const client = useQueryClient();
  const markRead = useMutation({ mutationFn: () => erpRequest(`v1/notifications/${item.id}/read`, { method: 'POST', body: '{}' }),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ['notifications'] }); } });
  return <li className={item.readAt === null ? 'notification-unread' : undefined}>
    <div className="item-title">{item.title}</div><p className="notification-body">{item.body}</p>
    <div className="item-meta"><span>{item.classification.toLowerCase()}</span>
      <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time></div>
    <div className="button-row">{item.actionPath !== null && <a href={item.actionPath}>Open related item</a>}
      {item.readAt === null && <button className="button button-secondary" type="button"
        disabled={markRead.isPending} onClick={() => markRead.mutate()}>Mark as read</button>}</div>
  </li>;
}
