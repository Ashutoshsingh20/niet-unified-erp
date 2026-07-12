import type { Metadata } from 'next';
import { Dashboard } from '@/components/dashboard';

export const metadata: Metadata = { title: 'Overview' };

export default function OverviewPage(): React.ReactNode {
  return <><header className="page-header"><div><h1>Today at NIET</h1>
    <p>Your live tasks and institutional updates, filtered by your current access.</p></div></header>
    <Dashboard /></>;
}

