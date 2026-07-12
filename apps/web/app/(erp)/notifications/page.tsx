import type { Metadata } from 'next';
import { NotificationCentre } from '@/components/notification-centre';

export const metadata: Metadata = { title: 'Notifications' };

export default function NotificationsPage(): React.ReactNode {
  return <><header className="page-header"><div><h1>Notifications</h1>
    <p>Institutional updates are retrieved securely from NIET after authentication.</p></div></header>
    <NotificationCentre /></>;
}

