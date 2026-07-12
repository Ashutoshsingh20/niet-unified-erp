import { render } from '@testing-library/react';
import { axe } from 'jest-axe';
import type { ImgHTMLAttributes, ReactElement } from 'react';
import { AppShell } from '../components/app-shell';

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
    const { container } = render(<AppShell><h1>Tasks and approvals</h1></AppShell>);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('marks the current navigation item', () => {
    const { getByRole } = render(<AppShell><h1>Tasks and approvals</h1></AppShell>);
    expect(getByRole('link', { name: 'Tasks & approvals' })).toHaveAttribute('aria-current', 'page');
  });
});
