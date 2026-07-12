import Image from 'next/image';
import Link from 'next/link';

export default async function SignInPage({ searchParams }: {
  searchParams: Promise<{ error?: string }>;
}): Promise<React.ReactNode> {
  const { error } = await searchParams;
  return <main className="auth-page" id="main-content">
    <section className="auth-panel" aria-labelledby="sign-in-title">
      <div className="brand-lockup"><Image src="/niet-logo.png" alt="NIET Greater Noida"
        width={200} height={76} priority /><span className="brand-text">Unified<br />ERP</span></div>
      <h1 id="sign-in-title">Sign in to NIET</h1>
      <p>Use your NIET institutional identity. Access is limited by your current role, department, programme, and assigned responsibilities.</p>
      {error !== undefined && <div className="error-banner" role="alert">Sign-in could not be completed. Please try again or contact NIET IT support.</div>}
      <Link className="button button-primary" href="/auth/login">Continue with NIET identity</Link>
      <p className="help">Multi-factor or passkey verification may be required for protected actions.</p>
    </section>
  </main>;
}

