'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { GlobalSearch } from './global-search';

const links = [
  { href: '/', label: 'Overview' },
  { href: '/student-core', label: 'My student record' },
  { href: '/workflows', label: 'Tasks & approvals' },
  { href: '/notifications', label: 'Notifications' },
] as const;

export function AppShell({ children }: Readonly<{ children: ReactNode }>): ReactNode {
  const pathname = usePathname();
  return <div className="app-frame">
    <header className="topbar">
      <Link className="brand-lockup" href="/" aria-label="NIET Unified ERP home">
        <Image src="/niet-logo.png" alt="" width={180} height={68} priority />
        <span className="brand-text">Unified<br />ERP</span>
      </Link>
      <GlobalSearch />
      <div className="top-actions">
        <Link className="button button-secondary" href={`/auth/login?stepUp=true&returnTo=${encodeURIComponent(pathname)}`}>Re-authenticate</Link>
        <form action="/auth/logout" method="post"><button className="button button-secondary" type="submit">Sign out</button></form>
      </div>
    </header>
    <aside className="sidebar" aria-label="Primary navigation"><nav>{links.map((link) =>
      <Link className="nav-link" href={{ pathname: link.href }} key={link.href}
        aria-current={pathname === link.href ? 'page' : undefined}>{link.label}</Link>)}</nav></aside>
    <main className="content" id="main-content">{children}</main>
  </div>;
}
