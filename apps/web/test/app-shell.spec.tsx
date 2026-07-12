import { render } from '@testing-library/react';
import { axe } from 'jest-axe';
import type { ImgHTMLAttributes, ReactElement } from 'react';
import { AppShell } from '../components/app-shell';
import { QueryProvider } from '../components/query-provider';

jest.mock('next/navigation', () => ({ usePathname: () => '/workflows' }));
jest.mock('next/image', () => ({ __esModule: true,
  default: ({ priority, ...props }: ImgHTMLAttributes<HTMLImageElement> & { priority?: boolean }): ReactElement => {
    void priority;
    return <img {...props} />;
  },
}));
jest.mock('next/link', () => 'a');

describe('AppShell', () => {
  it('has no automated accessibility violations in its primary structure', async () => {
    const { container } = render(<QueryProvider><AppShell><h1>Tasks and approvals</h1></AppShell></QueryProvider>);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('marks the current navigation item', () => {
    const { getByRole } = render(<QueryProvider><AppShell><h1>Tasks and approvals</h1></AppShell></QueryProvider>);
    expect(getByRole('link', { name: 'Tasks & approvals' })).toHaveAttribute('aria-current', 'page');
  });
});
