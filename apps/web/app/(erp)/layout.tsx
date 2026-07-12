import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { decryptSession, SESSION_COOKIE } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function ErpLayout({ children }: Readonly<{ children: ReactNode }>): Promise<ReactNode> {
  const value = (await cookies()).get(SESSION_COOKIE)?.value;
  if (value === undefined || await decryptSession(value) === null) redirect('/sign-in');
  return <AppShell>{children}</AppShell>;
}

