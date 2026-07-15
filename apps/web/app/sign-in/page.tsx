import Image from 'next/image';
import Link from 'next/link';
import { isSelfRegistrationEnabled } from '@/lib/server-env';

export default async function SignInPage({ searchParams }: {
  searchParams: Promise<{ error?: string }>;
}): Promise<React.ReactNode> {
  const { error } = await searchParams;
  const registrationEnabled = isSelfRegistrationEnabled();
  return <main className="auth-page" id="main-content">
    <section className="auth-panel" aria-labelledby="sign-in-title">
      <div className="brand-lockup"><Image src="/niet-logo.png" alt="NIET Greater Noida"
        width={200} height={76} priority /><span className="brand-text">Unified<br />ERP</span></div>
      <h1 id="sign-in-title">Sign in to NIET</h1>
      <p>Use your NIET institutional identity. Access is limited by your current role, department, programme, and assigned responsibilities.</p>
      {error === 'authentication_failed' && <div className="error-banner" role="alert">Sign-in could not be completed. Please try again or contact NIET IT support.</div>}
      {error === 'identity_unavailable' && <div className="error-banner" role="alert">NIET identity is temporarily unavailable. No credentials were accepted or stored by this application.</div>}
      {error === 'registration_unavailable' && <div className="error-banner" role="alert">Self-registration is not enabled for this environment. Contact NIET IT for account provisioning.</div>}
      <Link className="button button-primary" href="/auth/login">Continue with NIET identity</Link>
      {registrationEnabled && <Link className="button button-secondary"
        href={{ pathname: '/auth/register' }}>Create an account</Link>}
      <p className="help">Multi-factor or passkey verification may be required for protected actions.</p>
    </section>
  </main>;
}
