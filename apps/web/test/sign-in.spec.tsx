import { render } from '@testing-library/react';
import type { AnchorHTMLAttributes, ImgHTMLAttributes, ReactElement, ReactNode } from 'react';
import SignInPage from '../app/sign-in/page';

jest.mock('next/image', () => ({ __esModule: true,
  default: ({ priority, ...props }: ImgHTMLAttributes<HTMLImageElement> & { priority?: boolean }): ReactElement => {
    void priority;
    return <img {...props} />;
  },
}));
jest.mock('next/link', () => ({ __esModule: true,
  default: ({ href, children, ...props }: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
    href: string | { pathname?: string }; children?: ReactNode;
  }): ReactElement => <a {...props} href={typeof href === 'string' ? href : href.pathname}>{children}</a>,
}));

describe('SignInPage', () => {
  const previousRegistration = process.env.OIDC_SELF_REGISTRATION_ENABLED;

  afterEach(() => {
    if (previousRegistration === undefined) delete process.env.OIDC_SELF_REGISTRATION_ENABLED;
    else process.env.OIDC_SELF_REGISTRATION_ENABLED = previousRegistration;
  });

  it('does not offer self-registration by default', async () => {
    delete process.env.OIDC_SELF_REGISTRATION_ENABLED;
    const view = render(await SignInPage({ searchParams: Promise.resolve({}) }));
    expect(view.getByRole('link', { name: 'Continue with NIET identity' })).toHaveAttribute('href', '/auth/login');
    expect(view.queryByRole('link', { name: 'Create an account' })).not.toBeInTheDocument();
  });

  it('offers the OIDC registration flow only when explicitly enabled', async () => {
    process.env.OIDC_SELF_REGISTRATION_ENABLED = 'true';
    const view = render(await SignInPage({ searchParams: Promise.resolve({}) }));
    expect(view.getByRole('link', { name: 'Create an account' })).toHaveAttribute('href', '/auth/register');
  });

  it('shows an honest identity-provider outage message', async () => {
    const view = render(await SignInPage({
      searchParams: Promise.resolve({ error: 'identity_unavailable' }),
    }));
    expect(view.getByRole('alert')).toHaveTextContent('NIET identity is temporarily unavailable');
  });
});
