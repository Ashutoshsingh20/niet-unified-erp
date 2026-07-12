import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { QueryProvider } from '@/components/query-provider';

export const metadata: Metadata = {
  title: { default: 'NIET Unified ERP', template: '%s | NIET Unified ERP' },
  description: 'Secure academic and administrative workspace for NIET Greater Noida.',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>): ReactNode {
  return <html lang="en"><body><a className="skip-link" href="#main-content">Skip to main content</a>
    <QueryProvider>{children}</QueryProvider></body></html>;
}

