import { NextResponse, type NextRequest } from 'next/server';
import { beginAuthorization, identityUnavailable } from '@/lib/begin-authorization';
import { isSelfRegistrationEnabled } from '@/lib/server-env';

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!isSelfRegistrationEnabled()) {
    return NextResponse.redirect(new URL('/sign-in?error=registration_unavailable', request.url), 303);
  }
  try { return await beginAuthorization(request, { prompt: 'create' }); }
  catch (error) { return identityUnavailable(request, error); }
}
