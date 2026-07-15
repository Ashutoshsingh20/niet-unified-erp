import { type NextRequest, type NextResponse } from 'next/server';
import { beginAuthorization, identityUnavailable } from '@/lib/begin-authorization';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try { return await beginAuthorization(request); }
  catch (error) { return identityUnavailable(request, error); }
}
